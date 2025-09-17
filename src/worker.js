import dotenv from "dotenv";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import { createClient } from "redis";
import { WebClient } from "@slack/web-api";
import OpenAI from "openai";
import pLimit from "p-limit";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const STREAM = process.env.STREAM || "events:incoming";
const GROUP = process.env.CONSUMER_GROUP || "warpi-group";
const CONSUMER =
  process.env.WORKER_NAME || `worker-${Math.random().toString(36).slice(2, 8)}`;
const MAX_CONCURRENCY = parseInt(process.env.MAX_OPENAI_CONCURRENCY || "4", 10);
const MAX_SIZE = parseInt(process.env.MAX_EXCHANGES || "5", 10);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const limit = pLimit(MAX_CONCURRENCY);

// ---------------- Redis ----------------
let client;
async function initRedis() {
  if (!client) {
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
    await ensureConsumerGroup(client, STREAM, GROUP);
  }
}

export async function ensureConsumerGroup(
  client,
  stream = STREAM,
  group = GROUP
) {
  try {
    await client.sendCommand([
      "XGROUP",
      "CREATE",
      stream,
      group,
      "0",
      "MKSTREAM",
    ]);
    console.log(`Consumer group '${group}' created on stream '${stream}'`);
  } catch (err) {
    if (err.message.includes("BUSYGROUP")) {
      console.log(`ℹ Consumer group '${group}' already exists`);
    } else {
      console.error("Error creating consumer group:", err);
      throw err;
    }
  }
}

async function ackEntry(stream, group, id) {
  try {
    await client.sendCommand(["XACK", stream, group, id]);
    await client.sendCommand(["XDEL", stream, id]);
  } catch (err) {
    console.error(`Error acknowledging entry ${id}:`, err);
  }
}

// ---------------- Memory Helpers ----------------
function getThreadKey(body, event) {
  console.log("Event for thread key:", event);
  return `team-${body.team}:channel-${body.channel || event.channel}:threads`;
}

async function pushMemory(key, role, content, thread) {
  const obj = { role, content, id: Date.now(), threadId: thread || null };

  // Add new message at the end of list
  await client.rPush(`thread:MEMORY:${key}`, JSON.stringify(obj));

  // Trim the list to only keep the last 10
  await client.lTrim(`thread:MEMORY:${key}`, -MAX_SIZE, -1);
}

async function getMemory(key) {
  const arr = await client.lRange(`thread:MEMORY:${key}`, 0, -1);
  return arr.map((s) => JSON.parse(s));
}

async function getSlackClient(team_id) {
  const token = await client.hGet("slack_tokens", team_id);
  return new WebClient(token);
}

// ---------------- Dead Letter Queue ----------------
async function moveToDLQ(id, payload) {
  try {
    await client.sendCommand([
      "XADD",
      "events:dlq",
      "*",
      "original_id",
      id,
      "payload",
      JSON.stringify(payload),
    ]);
  } catch (err) {
    console.error(`Error moving entry ${id} to DLQ:`, err);
  }
}

// ---------------- Worker ----------------
async function processEntry(entryId, payload) {
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch (err) {
    console.error("Invalid payload:", payload, err);
    await moveToDLQ(entryId, { raw: payload });
    await ackEntry(STREAM, GROUP, entryId);
    return;
  }

  const { event, body, added } = parsed;
  if (added === 0) {
    await ackEntry(STREAM, GROUP, entryId);
    return;
  }

  const threadKey = getThreadKey(body, event);

  // ---------------- Fetch context ----------------
  let history = [];
  try {
    history = await getMemory(threadKey);
  } catch (err) {
    history = [];
    console.error("Error fetching memory:", err);
  }
  const messages = [
    { role: "system", content: "You are Warpi — a helpful Slack assistant." },
    ...history,
    { role: "user", content: event.text || body?.message || "" },
  ];

  // ---------------- Generate response ----------------
  await limit(async () => {
    let answer = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const resp = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages,
        });
        answer = resp.choices?.[0]?.message?.content?.trim();
        break;
      } catch (err) {
        console.warn(`OpenAI attempt ${attempt} failed:`, err?.message);
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    }

    if (!answer) {
      console.error("OpenAI failed for entry:", entryId);
      await moveToDLQ(entryId, { event, body, error: "OpenAI failed" });
      await ackEntry(STREAM, GROUP, entryId);
      return;
    }

    try {
      console.log("event", event);
      console.log("body", body);
      const slack = await getSlackClient(body.team);
      await slack.chat.postMessage({
        channel: event.channel,
        thread_ts: event.thread_ts || event.ts,
        text: answer,
      });
    } catch (err) {
      console.error("Error posting to Slack:", err);
      await moveToDLQ(entryId, { event, body, error: "Slack update failed" });
      await ackEntry(STREAM, GROUP, entryId);
      return;
    }

    // ---------------- Save memory ----------------
    try {
      await pushMemory(
        threadKey,
        "user",
        event.text || body?.message || "",
        event.thread_ts || event.ts
      );
      await pushMemory(
        threadKey,
        "assistant",
        answer,
        event.thread_ts || event.ts
      );
    } catch (err) {
      console.error("Error saving memory:", err.message);
    }

    await ackEntry(STREAM, GROUP, entryId);
  });
}

// ---------------- Run Worker ----------------
async function runWorker() {
  await initRedis();
  console.log(`▶ Worker ${CONSUMER} started`);

  while (true) {
    let res;
    try {
      res = await client.sendCommand([
        "XREADGROUP",
        "GROUP",
        GROUP,
        CONSUMER,
        "BLOCK",
        "2000",
        "COUNT",
        "5",
        "STREAMS",
        STREAM,
        ">",
      ]);
    } catch (err) {
      console.error("Error reading from Redis stream:", err);
      continue;
    }
    if (!res) continue;

    const entries = res[0][1];
    for (const e of entries) {
      const entryId = e[0];
      const payload = e[1][1];
      try {
        console.log(`Processing entry ${entryId}`);
        await processEntry(entryId, payload);
      } catch (err) {
        console.error(`Error processing entry ${entryId}:`, err);
        await moveToDLQ(entryId, { raw: payload, error: err.message });
        await ackEntry(STREAM, GROUP, entryId);
      }
    }
  }
}

runWorker().catch((err) => {
  console.error("Worker crash:", err);
  process.exit(1);
});

process.on("SIGINT", async () => {
  if (client) {
    await client.quit();
    console.log("Redis connection closed gracefully.");
  }
  process.exit(0);
});
