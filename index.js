import pkg from "@slack/bolt";
const { App, ExpressReceiver } = pkg;
import dotenv from "dotenv";
import express from "express";
import { pushUserEvent } from "./src/redisClient.js";
import { deleteMsgHandler } from "./src/redisClient.js";
import { storeWorkspaceToken } from "./src/redisClient.js";

dotenv.config();

// --- OpenAI ---

// --- Slack Receiver ---
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// --- Slack App ---
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver, // Important to use ExpressReceiver
});

// --- Express App ---
const expressApp = receiver.app;
expressApp.use(express.json());

// expressApp.post("/", (req, res, next) => {
//   const { body } = req;
//   const challenge = body?.challenge;
//   console.log("Received body:", body);
//   console.log("Received challenge:", challenge);
//   res.send(challenge || "no challenge");
// });

expressApp.post("/", async (req, res) => {
  const { body } = req;
  // Only process event callbacks
  if (body.type === "event_callback" && body.event?.type === "app_mention") {
    const event = body.event;
    const userMessage = event.text.replace(/<@[^>]+>\s*/, "").trim();

    try {
      await pushUserEvent(event.user, userMessage, event);

      res.status(200).send("Event received");
    } catch (err) {
      console.error("Error sending Slack reply:", err);
    }
  } else if (
    body.event.subtype === "message_deleted" ||
    (body.event.subtype === "message_changed" &&
      body.event.message?.subtype === "tombstone")
  ) {
    await deleteMsgHandler(body.event);
    res.status(200).send("Deletion event handled");
  } else {
    res.status(200).send("No action taken");
  }
});

expressApp.get("/", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.status(400).send("No code provided");

  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: process.env.SLACK_REDIRECT_URI,
    }),
  }).then((r) => r.json());

  if (!response.ok) return res.status(500).send(response);

  // Store access token in DB or Redis
  console.log("New workspace token:", response.access_token);
  storeWorkspaceToken(response);

  res.send("App installed successfully!");
});

// --- Start server ---
(async () => {
  const PORT = process.env.PORT || 3001;
  await app.start(PORT);
  console.log(`⚡️ Warpi bot is running on port ${PORT}`);
})();
