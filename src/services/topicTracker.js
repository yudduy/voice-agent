const redis = require('../config/redis');
const KEY = (uid) => `topics:${uid}`;

async function getCovered(userId) {
  const raw = await redis.get(KEY(userId));
  return raw ? JSON.parse(raw) : [];
}

async function markCovered(userId, topic) {
  const topics = new Set(await getCovered(userId));
  topics.add(topic);
  await redis.set(KEY(userId), JSON.stringify([...topics]), { ex: 60*60*24 });
}

module.exports = { getCovered, markCovered }; 