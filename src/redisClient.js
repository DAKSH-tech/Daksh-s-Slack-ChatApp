import { createClient } from "redis";

const STREAM = "events:incoming";
const GROUP = process.env.CONSUMER_GROUP || "warpi-group";

let client; // Singleton Redis client

// ---------------- Redis Init ----------------
export async function initRedis() {
  if (!client) {
    // Use REDIS_URL if provided; fallback to host/port for local dev
    const redisOptions = process.env.REDIS_URL
      ? { url: process.env.REDIS_URL }
      : {
          socket: {
            host: process.env.REDIS_HOST || "127.0.0.1",
            port: parseInt(process.env.REDIS_PORT || "6379", 10),
          },
          password: process.env.REDIS_PASSWORD || undefined,
          database: 0,
        };

    client = createClient(redisOptions);

    client.on("error", (err) => console.error("Redis Client Error", err));

    await client.connect();
    console.log("✅ Redis connected");
  }
  return client;
}
// ---------------- Consumer Group ----------------
export async function ensureConsumerGroup(
  clientInstance,
  stream = STREAM,
  group = GROUP
) {
  try {
    await clientInstance.sendCommand([
      "XGROUP",
      "CREATE",
      stream,
      group,
      "0",
      "MKSTREAM",
    ]);
    console.log(`Consumer group '${group}' created on stream '${stream}'`);
  } catch (err) {
    if (err.message && err.message.includes("BUSYGROUP")) {
      console.log(`ℹ Consumer group '${group}' already exists`);
    } else {
      console.error("Error creating consumer group:", err.message);
      throw err;
    }
  }
}

// ---------------- Get Client ----------------
export function getClient() {
  if (!client)
    throw new Error("Redis client not initialized. Call initRedis() first.");
  return client;
}

// ---------------- Push User Event ----------------
export async function pushUserEvent(userId, message, event) {
  if (typeof userId !== "string" || typeof message !== "string") {
    throw new Error("Invalid userId or message type");
  }

  const c = getClient();

  // Determine keys for channel or thread
  const channel = event?.channel || "unknown";
  const thread_ts = event?.thread_ts || null;

  // Payload structure for stream
  const payload = {
    event: { channel, ts: event?.ts || Date.now().toString(), text: message },
    body: {
      userId,
      message,
      team: event?.team || event?.bot_profile?.team_id || "unknown",
      channel,
      thread_ts,
    },
    uniqueId: `${userId}-${Date.now()}`,
    added: 1,
  };

  try {
    await c.sendCommand([
      "XADD",
      STREAM,
      "*",
      "payload",
      JSON.stringify(payload),
    ]);
    console.log("Event pushed to stream:", payload.uniqueId);
  } catch (err) {
    console.error("Error pushing user event to stream:", err.message);
    throw err;
  }
}
export async function deleteMsgHandler(event) {
  const channelId = event.channel;
  console.log(" Handling deletion event:", event);

  if (
    !(
      event.subtype === "message_deleted" ||
      (event.subtype === "message_changed" &&
        event.message?.subtype === "tombstone")
    )
  ) {
    return; // Not a deletion event
  }

  const threadKey = `thread:MEMORY:team-${
    event.team_id || event.team
  }:channel-${channelId}:threads`;

  // Get all messages from this thread
  const redisClient = getClient();
  console.log("Thread key for deletion:", threadKey);
  const messages = await redisClient.lRange(threadKey, 0, -1);
  console.log("Fetched messages for deletion check:", messages);

  // Rewrite the thread list without the deleted message
  // Remove only the deleted message from the list
  for (const msg of messages) {
    try {
      const parsed = JSON.parse(msg);
      if (parsed?.threadId === event.thread_ts) {
        await redisClient.lRem(threadKey, 1, msg); // Remove only this message
      }
    } catch (e) {
      // Ignore parse errors
    }
  }
}
// ---------------- Graceful shutdown ----------------
process.on("SIGINT", async () => {
  if (client) {
    await client.quit();
    console.log("Redis connection closed gracefully.");
  }
  process.exit(0);
});

// Initialize Redis on module load
(async () => {
  await initRedis();
})();
