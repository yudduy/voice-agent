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

/**
 * Track topics in conversation (alias for markCovered for compatibility)
 * @param {string} userId - User ID
 * @param {string|Array} topics - Topic(s) to track
 */
async function trackTopics(userId, topics) {
  if (Array.isArray(topics)) {
    for (const topic of topics) {
      await markCovered(userId, topic);
    }
  } else {
    await markCovered(userId, topics);
  }
}

module.exports = { getCovered, markCovered, trackTopics }; 