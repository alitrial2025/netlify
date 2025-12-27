const admin = require('firebase-admin');

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};

const jsonResponse = (statusCode, body) => ({
  statusCode,
  headers: {
    ...CORS_HEADERS,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
});

const initAdmin = () => {
  if (admin.apps?.length) return;

  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!rawJson) {
    throw new Error('Missing FIREBASE_SERVICE_ACCOUNT env var');
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(rawJson);
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT must be valid JSON');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
};

const getBearerToken = (headers = {}) => {
  const raw = headers.authorization || headers.Authorization;
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
};

const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const uniq = (arr) => Array.from(new Set((arr || []).filter(Boolean)));

const parseCsv = (value) =>
  String(value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const DEFAULT_BROADCAST_ADMIN_EMAILS = ['vivescharris8@gmail.com'];

const getBroadcastAdminEmails = () => {
  const fromEnv = parseCsv(process.env.BROADCAST_ADMIN_EMAILS).map((e) => e.toLowerCase());
  return uniq([...DEFAULT_BROADCAST_ADMIN_EMAILS.map((e) => e.toLowerCase()), ...fromEnv]);
};

const getBroadcastAdminUids = () => uniq(parseCsv(process.env.BROADCAST_ADMIN_UIDS));

const isBroadcastAdmin = (decoded) => {
  const uid = decoded && decoded.uid;
  const email = String((decoded && decoded.email) || '').toLowerCase();
  const allowedUids = getBroadcastAdminUids();
  const allowedEmails = getBroadcastAdminEmails();
  return (uid && allowedUids.includes(uid)) || (email && allowedEmails.includes(email));
};

const getUserExpoTokens = (userDoc) => {
  const data = (userDoc && userDoc.data && userDoc.data()) || {};
  const tokens = [];
  if (typeof data.expoPushToken === 'string' && data.expoPushToken) tokens.push(data.expoPushToken);
  if (Array.isArray(data.expoPushTokens)) tokens.push(...data.expoPushTokens);
  return uniq(tokens).filter((t) => typeof t === 'string' && t.startsWith('ExponentPushToken'));
};

const sendExpoPush = async (messages) => {
  if (!messages.length) return { ok: true, receipts: [] };

  const results = [];
  for (const batch of chunk(messages, 100)) {
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(batch),
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    results.push({ status: res.status, body: data });
  }
  return { ok: true, receipts: results };
};

const pickDisplayName = (userData) => {
  if (!userData || typeof userData !== 'object') return 'MovieFlix';
  return userData.displayName || userData.username || userData.name || 'MovieFlix';
};

const loadRecipientsFromUserIds = async (db, userIds) => {
  const ids = uniq(userIds).filter((id) => typeof id === 'string' && id.length);
  if (!ids.length) return { ids: [], userDocs: [] };
  const userDocs = await Promise.all(ids.map((id) => db.collection('users').doc(id).get()));
  return { ids, userDocs };
};

const buildExpoMessagesForRecipients = ({ ids, userDocs }, { title, body, data }) => {
  const expoMessages = [];
  userDocs.forEach((snap, idx) => {
    const userId = ids[idx];
    const tokens = getUserExpoTokens(snap);
    tokens.forEach((to) => {
      expoMessages.push({
        to,
        title,
        body,
        sound: 'default',
        channelId: 'default',
        priority: 'high',
        data: { ...(data || {}), toUserId: userId },
      });
    });
  });
  return expoMessages;
};

const parseNumber = (v) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : null;
};

const buildUrl = (pathname, params) => {
  const entries = Object.entries(params || {}).filter(([, v]) => v != null && String(v).length);
  if (!entries.length) return pathname;
  const query = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  return `${pathname}?${query}`;
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { ...CORS_HEADERS, Allow: 'POST,OPTIONS' },
      body: '',
    };
  }

  try {
    initAdmin();
  } catch (err) {
    return jsonResponse(500, { error: err.message || 'Firebase admin init failed' });
  }

  const token = getBearerToken(event.headers || {});
  if (!token) return jsonResponse(401, { error: 'Missing Authorization bearer token' });

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(token);
  } catch {
    return jsonResponse(401, { error: 'Invalid auth token' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const kind = body && body.kind;
  const uid = decoded && decoded.uid;
  if (!uid) return jsonResponse(401, { error: 'Auth missing uid' });

  const isAdmin = isBroadcastAdmin(decoded);

  const db = admin.firestore();

  try {
    if (kind === 'message') {
      const conversationId = String(body.conversationId || '');
      const messageId = String(body.messageId || '');
      if (!conversationId || !messageId) return jsonResponse(400, { error: 'Missing conversationId/messageId' });

      const convRef = db.collection('conversations').doc(conversationId);
      const convSnap = await convRef.get();
      if (!convSnap.exists) return jsonResponse(404, { error: 'Conversation not found' });

      const conv = convSnap.data() || {};
      const members = Array.isArray(conv.members) ? conv.members : [];
      if (!members.includes(uid)) return jsonResponse(403, { error: 'Not a member of this conversation' });

      const msgRef = convRef.collection('messages').doc(messageId);
      const msgSnap = await msgRef.get();
      if (!msgSnap.exists) return jsonResponse(404, { error: 'Message not found' });

      const msg = msgSnap.data() || {};
      const from = msg.from || msg.sender;
      if (from !== uid) return jsonResponse(403, { error: 'Not the sender of this message' });

      const senderSnap = await db.collection('users').doc(uid).get();
      const sender = senderSnap.exists ? senderSnap.data() || {} : {};
      const senderName = sender.displayName || sender.username || 'New message';

      const isGroup = !!conv.isGroup;
      const title = isGroup ? (conv.name || conv.conversationName || 'Group') : senderName;

      const preview = (() => {
        if (typeof msg.text === 'string' && msg.text.trim()) return msg.text.trim();
        if (msg.mediaType === 'image') return 'Photo';
        if (msg.mediaType === 'video') return 'Video';
        if (msg.mediaType === 'audio') return 'Audio message';
        if (msg.mediaUrl) return 'Attachment';
        return 'New message';
      })();
      const bodyText = isGroup ? `${senderName}: ${preview}` : preview;

      const recipients = uniq(members).filter((m) => m && m !== uid);
      const userDocs = await Promise.all(recipients.map((id) => db.collection('users').doc(id).get()));

      const expoMessages = [];
      userDocs.forEach((snap, idx) => {
        const userId = recipients[idx];
        const tokens = getUserExpoTokens(snap);
        tokens.forEach((to) => {
          expoMessages.push({
            to,
            title,
            body: bodyText,
            sound: 'default',
            channelId: 'default',
            priority: 'high',
            data: { type: 'message', conversationId, messageId, from: uid, toUserId: userId },
          });
        });
      });

      const result = await sendExpoPush(expoMessages);
      return jsonResponse(200, { ok: true, kind, sent: expoMessages.length, result });
    }

    if (kind === 'call') {
      const callId = String(body.callId || '');
      if (!callId) return jsonResponse(400, { error: 'Missing callId' });

      const callSnap = await db.collection('calls').doc(callId).get();
      if (!callSnap.exists) return jsonResponse(404, { error: 'Call not found' });
      const call = callSnap.data() || {};

      if (call.initiatorId !== uid) return jsonResponse(403, { error: 'Not the initiator of this call' });
      const members = Array.isArray(call.members) ? call.members : [];

      const recipients = uniq(members).filter((m) => m && m !== uid);
      const userDocs = await Promise.all(recipients.map((id) => db.collection('users').doc(id).get()));

      const callType = call.type === 'video' ? 'video' : 'voice';
      const title = callType === 'video' ? 'Incoming video call' : 'Incoming voice call';
      const bodyText = call.conversationName || 'MovieFlix';

      const expoMessages = [];
      userDocs.forEach((snap, idx) => {
        const userId = recipients[idx];
        const tokens = getUserExpoTokens(snap);
        tokens.forEach((to) => {
          expoMessages.push({
            to,
            title,
            body: bodyText,
            sound: 'default',
            channelId: 'default',
            priority: 'high',
            data: { type: 'call', callId, from: uid, toUserId: userId },
          });
        });
      });

      const result = await sendExpoPush(expoMessages);
      return jsonResponse(200, { ok: true, kind, sent: expoMessages.length, result });
    }

    if (kind === 'story') {
      const storyId = String(body.storyId || '');
      if (!storyId) return jsonResponse(400, { error: 'Missing storyId' });

      const storySnap = await db.collection('stories').doc(storyId).get();
      if (!storySnap.exists) return jsonResponse(404, { error: 'Story not found' });
      const story = storySnap.data() || {};
      if (String(story.userId || '') !== uid) return jsonResponse(403, { error: 'Not the owner of this story' });

      const senderSnap = await db.collection('users').doc(uid).get();
      const sender = senderSnap.exists ? senderSnap.data() || {} : {};
      const senderName = pickDisplayName(sender) || story.username || 'Someone';

      const followers = Array.isArray(sender.followers) ? sender.followers : [];
      const recipients = uniq(followers).filter((m) => m && m !== uid);
      const { ids, userDocs } = await loadRecipientsFromUserIds(db, recipients);

      const caption = typeof story.caption === 'string' ? story.caption.trim() : '';
      const overlayText = typeof story.overlayText === 'string' ? story.overlayText.trim() : '';
      const bodyText = caption || overlayText || 'Tap to view';

      const url = `/story/${encodeURIComponent(storyId)}`;
      const expoMessages = buildExpoMessagesForRecipients(
        { ids, userDocs },
        {
          title: `${senderName} posted a story`,
          body: bodyText,
          data: { type: 'story', storyId, from: uid, url },
        },
      );

      const result = await sendExpoPush(expoMessages);
      return jsonResponse(200, { ok: true, kind, sent: expoMessages.length, result });
    }

    if (kind === 'reel') {
      const reviewId = String(body.reviewId || '');
      if (!reviewId) return jsonResponse(400, { error: 'Missing reviewId' });

      const reviewSnap = await db.collection('reviews').doc(reviewId).get();
      if (!reviewSnap.exists) return jsonResponse(404, { error: 'Review not found' });
      const review = reviewSnap.data() || {};
      if (String(review.userId || '') !== uid) return jsonResponse(403, { error: 'Not the owner of this review' });

      const senderSnap = await db.collection('users').doc(uid).get();
      const sender = senderSnap.exists ? senderSnap.data() || {} : {};
      const senderName = pickDisplayName(sender) || 'Someone';

      const followers = Array.isArray(sender.followers) ? sender.followers : [];
      const recipients = uniq(followers).filter((m) => m && m !== uid);
      const { ids, userDocs } = await loadRecipientsFromUserIds(db, recipients);

      const titleValue = typeof review.title === 'string' && review.title.trim() ? review.title.trim() : 'Reel';
      const videoUrl = review.videoUrl || review.mediaUrl || null;

      // Deep link into the reels feed with a single-item queue
      const queueItem = {
        id: String(reviewId),
        mediaType: 'feed',
        title: titleValue,
        videoUrl: videoUrl,
        avatar: review.userAvatar || sender.photoURL || null,
        user: uid,
        docId: String(reviewId),
        likes: typeof review.likes === 'number' ? review.likes : 0,
        commentsCount: typeof review.commentsCount === 'number' ? review.commentsCount : 0,
        likerAvatars: [],
        music: `Original Sound - ${senderName}`,
      };
      const listParam = JSON.stringify([queueItem]);
      const url = buildUrl('/reels/feed', { list: listParam, id: String(reviewId) });

      const preview = (() => {
        if (typeof review.review === 'string' && review.review.trim()) return review.review.trim();
        if (typeof review.type === 'string' && review.type === 'video') return 'New video';
        return 'Tap to watch';
      })();

      const expoMessages = buildExpoMessagesForRecipients(
        { ids, userDocs },
        {
          title: `${senderName} posted a reel`,
          body: preview,
          data: { type: 'reel', reviewId, from: uid, url },
        },
      );

      const result = await sendExpoPush(expoMessages);
      return jsonResponse(200, { ok: true, kind, sent: expoMessages.length, result });
    }

    if (kind === 'continue_watching') {
      const tmdbId = String(body.tmdbId || '');
      if (!tmdbId) return jsonResponse(400, { error: 'Missing tmdbId' });

      const toUserId = String(body.toUserId || uid);
      if (toUserId !== uid && !isAdmin) return jsonResponse(403, { error: 'Not allowed to notify other users' });

      const mediaType = String(body.mediaType || 'movie') === 'tv' ? 'tv' : 'movie';
      const resumeMillis = parseNumber(body.resumeMillis);
      const seasonNumber = parseNumber(body.seasonNumber);
      const episodeNumber = parseNumber(body.episodeNumber);
      const titleValue = typeof body.title === 'string' ? body.title.trim() : '';

      const url = buildUrl('/video-player', {
        mediaType,
        tmdbId,
        resumeMillis: resumeMillis != null ? Math.max(0, Math.floor(resumeMillis)) : undefined,
        seasonNumber: seasonNumber != null ? Math.max(1, Math.floor(seasonNumber)) : undefined,
        episodeNumber: episodeNumber != null ? Math.max(1, Math.floor(episodeNumber)) : undefined,
      });

      const { ids, userDocs } = await loadRecipientsFromUserIds(db, [toUserId]);
      const expoMessages = buildExpoMessagesForRecipients(
        { ids, userDocs },
        {
          title: 'Continue watching',
          body: titleValue || 'Tap to resume',
          data: { type: 'continue_watching', tmdbId, mediaType, resumeMillis: resumeMillis ?? undefined, url },
        },
      );

      const result = await sendExpoPush(expoMessages);
      return jsonResponse(200, { ok: true, kind, sent: expoMessages.length, result });
    }

    if (kind === 'new_movie') {
      if (!isAdmin) return jsonResponse(403, { error: 'Admin only' });

      const tmdbId = String(body.tmdbId || '');
      if (!tmdbId) return jsonResponse(400, { error: 'Missing tmdbId' });
      const mediaType = String(body.mediaType || 'movie') === 'tv' ? 'tv' : 'movie';
      const titleValue = typeof body.title === 'string' ? body.title.trim() : '';
      const releaseYear = parseNumber(body.releaseYear);

      let recipients = Array.isArray(body.userIds) ? body.userIds : [];
      const audience = String(body.audience || '').toLowerCase();
      const maxUsers = Math.max(1, Math.min(1000, parseNumber(body.maxUsers) || 250));
      if (!recipients.length && audience === 'all') {
        const snap = await db.collection('users').limit(maxUsers).get();
        recipients = snap.docs.map((d) => d.id);
      }
      const { ids, userDocs } = await loadRecipientsFromUserIds(db, recipients);

      const url = buildUrl(`/details/${encodeURIComponent(tmdbId)}`, { mediaType });
      const bodyText = titleValue
        ? `${titleValue}${releaseYear ? ` (${releaseYear})` : ''} is now available.`
        : 'A new movie is now available.';

      const expoMessages = buildExpoMessagesForRecipients(
        { ids, userDocs },
        {
          title: 'New movie drop',
          body: bodyText,
          data: { type: 'new_movie', tmdbId, mediaType, url },
        },
      );

      const result = await sendExpoPush(expoMessages);
      return jsonResponse(200, { ok: true, kind, sent: expoMessages.length, result });
    }

    if (kind === 'app_update') {
      if (!isAdmin) return jsonResponse(403, { error: 'Admin only' });

      const titleValue = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : 'Update available';
      const bodyText = typeof body.body === 'string' && body.body.trim()
        ? body.body.trim()
        : 'A new update is ready. Tap to open the app.';

      let recipients = Array.isArray(body.userIds) ? body.userIds : [];
      const audience = String(body.audience || '').toLowerCase();
      const maxUsers = Math.max(1, Math.min(1000, parseNumber(body.maxUsers) || 250));
      if (!recipients.length && audience === 'all') {
        const snap = await db.collection('users').limit(maxUsers).get();
        recipients = snap.docs.map((d) => d.id);
      }
      const { ids, userDocs } = await loadRecipientsFromUserIds(db, recipients);

      const url = typeof body.url === 'string' && body.url.trim() ? body.url.trim() : '/settings';
      const externalUrl = typeof body.externalUrl === 'string' && body.externalUrl.trim() ? body.externalUrl.trim() : undefined;

      const expoMessages = buildExpoMessagesForRecipients(
        { ids, userDocs },
        {
          title: titleValue,
          body: bodyText,
          data: { type: 'app_update', url, externalUrl },
        },
      );

      const result = await sendExpoPush(expoMessages);
      return jsonResponse(200, { ok: true, kind, sent: expoMessages.length, result });
    }

    return jsonResponse(400, { error: 'Unsupported kind' });
  } catch (err) {
    return jsonResponse(500, { error: err.message || 'Failed to send notification' });
  }
};
