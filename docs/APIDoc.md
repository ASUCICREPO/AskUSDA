# AskUSDA APIs

This document provides API documentation for the AskUSDA Chatbot: **WebSocket API** (chat, feedback, escalation) and **HTTP Admin API** (metrics, feedback, escalations).

---

## Overview

- **WebSocket API** (`AskUSDA-WebSocket`): Chat with the USDA knowledge base, submit thumbs up/down feedback, and submit escalation requests. Used by the hover-over chatbot on the main page.
- **HTTP Admin API** (`AskUSDA-AdminAPI`): Dashboard metrics, conversation feedback list, and escalation CRUD. Used by the `/admin` dashboard. GET and DELETE routes are protected by Cognito JWT; POST /feedback and POST /escalations are public.

---

## Base URLs

**WebSocket API (chat, feedback, escalation):**
```
wss://[API_ID].execute-api.[REGION].amazonaws.com/prod
```

**HTTP Admin API:**
```
https://[API_ID].execute-api.[REGION].amazonaws.com
```

> Replace with your actual API Gateway endpoints (from CDK outputs: `AskUSDA-WebSocketUrl`, `AskUSDA-AdminApiUrl`).

---

## Authentication

### WebSocket API
- No authentication. Clients connect and send messages; each connection is identified by `connectionId` (from API Gateway).

### HTTP Admin API
- **Protected (Cognito JWT required):** `GET /metrics`, `GET /feedback`, `DELETE /escalations/{id}`. Send `Authorization: <Cognito IdToken>`.
- **Public (no auth):** `POST /feedback`, `POST /escalations` (used by the chatbot and escalation form).

### Headers (HTTP Admin API)
| Header | Description | Required |
|--------|-------------|----------|
| `Content-Type` | `application/json` | Yes (for POST) |
| `Authorization` | Cognito JWT (Id token) | Protected routes only |

---

## 1) WebSocket API

Connect to the WebSocket URL, then send JSON messages. The route is determined by the **route key** (API Gateway) or by an **action** field in the body for `$default`.

### Routes

| Route Key | Description |
|-----------|-------------|
| `$connect` | Client connects (no body) |
| `$disconnect` | Client disconnects |
| `sendMessage` | Send a chat message and receive answer + citations |
| `submitFeedback` | Submit thumbs up/down for a conversation (saves conversation to DB) |
| `submitEscalation` | Submit an escalation request (name, email, phone, question) |

---

#### sendMessage

- **Purpose:** Send a user question to the USDA knowledge base and receive an answer with citations (single response, not chunked streaming).

- **Request (body):**
```json
{
  "message": "string (required) - The user's question",
  "sessionId": "string (optional) - Bedrock session ID for conversation continuity"
}
```

- **Response (sent to client over WebSocket):**
  - `type: "typing"`, `isTyping: true` — typing indicator
  - `type: "message"` — final message with:
    - `message` — answer text
    - `citations` — array of `{ id, text, source, score }`
    - `conversationId` — UUID for this Q&A (use when submitting feedback)
    - `sessionId` — Bedrock session ID (optional, for follow-up)
    - `responseTimeMs` — response time
    - `question` — echoed user question
  - `type: "error"` — `message` with error description (e.g. guardrail blocked, server error)

- **Guardrail:** Input is checked; if blocked, client receives `type: "message"` with `blocked: true` and a safe message.

---

#### submitFeedback

- **Purpose:** Record positive or negative feedback for a specific Q&A. This also **saves the conversation** to DynamoDB (Conversation History) so it appears in the admin feedback list.

- **Request (body):**
```json
{
  "conversationId": "string (required) - UUID from sendMessage response",
  "feedback": "string (required) - 'positive' | 'negative'",
  "question": "string (optional) - User question (for storage)",
  "answer": "string (optional) - Bot answer (for storage)",
  "sessionId": "string (optional)",
  "responseTimeMs": "number (optional)",
  "citations": "array (optional)"
}
```

- **Response:** `type: "feedbackConfirmation"` with `success: true`, `conversationId`, `feedback`. On error, `type: "error"` with `message`.

---

#### submitEscalation

- **Purpose:** Submit an escalation/support request (name, email, phone, question). Stored in Escalation Requests table and visible in the admin dashboard.

- **Request (body):**
```json
{
  "name": "string (required)",
  "email": "string (required)",
  "phone": "string (optional)",
  "question": "string (required)",
  "sessionId": "string (optional)"
}
```

- **Response:** `type: "escalationConfirmation"` with `success: true`, `escalationId`, `message`. On error, `type: "error"` with `message`.

---

## 2) HTTP Admin API

All responses are JSON. CORS is enabled.

---

#### GET /metrics — Dashboard statistics

- **Purpose:** Aggregated metrics for the admin dashboard (conversations by day, feedback counts, response time). **Cognito protected.**

- **Query parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `days` | number | No | Number of days to include (default: 7) |

- **Example:** `GET /metrics?days=7`

- **Response:**
```json
{
  "totalConversations": 150,
  "conversationsToday": 23,
  "totalFeedback": 45,
  "positiveFeedback": 38,
  "negativeFeedback": 7,
  "noFeedback": 105,
  "satisfactionRate": 84,
  "avgResponseTimeMs": 2340,
  "conversationsByDay": [
    {
      "date": "2025-01-05",
      "count": 20,
      "dayName": "Tue",
      "label": "Jan 5"
    }
  ]
}
```

---

#### GET /feedback — Conversation feedback list

- **Purpose:** List conversations that have feedback (for admin table). **Cognito protected.**

- **Query parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | No | Max items (default: 50) |
| `filter` | string | No | `pos` or `neg` to filter by feedback type |

- **Example:** `GET /feedback?limit=50&filter=neg`

- **Response:**
```json
{
  "conversations": [
    {
      "conversationId": "uuid",
      "sessionId": "string",
      "question": "User question...",
      "answerPreview": "First 500 chars of answer...",
      "feedback": "pos",
      "timestamp": "2025-01-05T10:30:00.000Z",
      "date": "2025-01-05",
      "responseTimeMs": 2340
    }
  ]
}
```

---

#### POST /feedback — Submit or update feedback (public)

- **Purpose:** Record feedback for a conversation by `conversationId`. Used when the conversation already exists in DynamoDB (e.g. after WebSocket submitFeedback). **Public (no auth).**

- **Request body:**
```json
{
  "conversationId": "string (required) - UUID of the conversation",
  "feedback": "string (required) - 'positive' | 'negative' (or 'pos' | 'neg')"
}
```

- **Response:** `200` with `{ "success": true }`. `400` if missing params; `404` if conversation not found; `500` on server error.

---

#### GET /escalations — List escalation requests

- **Purpose:** List all escalation requests for the admin dashboard. **Cognito protected.**

- **Response:**
```json
{
  "escalations": [
    {
      "id": "escalationId-uuid",
      "name": "John Doe",
      "email": "john@example.com",
      "phone": "+1234567890",
      "question": "Need help with...",
      "requestDate": "2025-01-05T10:30:00.000Z",
      "status": "pending"
    }
  ]
}
```

---

#### POST /escalations — Create escalation (public)

- **Purpose:** Create a new escalation request (e.g. from chatbot or contact form). **Public (no auth).**

- **Request body:**
```json
{
  "name": "string (required)",
  "email": "string (required)",
  "phone": "string (optional)",
  "question": "string (required)",
  "sessionId": "string (optional)"
}
```

- **Response:** `200` with `{ "success": true, "escalationId": "uuid" }`. `400` if name, email, or question missing; `500` on server error.

---

#### DELETE /escalations/{id} — Delete escalation

- **Purpose:** Delete an escalation request by its `escalationId`. **Cognito protected.**

- **Path parameters:** `id` — the escalation ID (UUID).

- **Response:** `200` with `{ "success": true }`. `404` if not found; `500` on server error.

---

## Response format (HTTP Admin API)

- Success: `statusCode: 200` (or `201` where applicable), `body` is JSON (object or array as above).
- Error: `statusCode: 400 | 404 | 500`, `body` includes `error` message.

---

## Error codes (HTTP)

| Code | Description |
|------|-------------|
| 400 | Bad request (missing or invalid parameters) |
| 401 | Unauthorized (missing or invalid Cognito token on protected routes) |
| 404 | Not found (conversation or escalation) |
| 500 | Internal server error |

---

## DynamoDB table schemas

### Conversation History (`AskUSDA-ConversationHistory`)

- **Keys:** `conversationId` (PK), `timestamp` (SK)
- **GSIs:** `sessionId-timestamp-index`, `date-timestamp-index`, `feedback-timestamp-index`
- **Attributes:** `sessionId`, `question`, `answer`, `answerPreview`, `citations` (JSON string), `responseTimeMs`, `date`, `feedback` (`pos`/`neg`), `feedbackTs`, `ttl`

Conversations are written when the user submits feedback (WebSocket submitFeedback or POST /feedback for an existing record).

### Escalation Requests (`AskUSDA-EscalationRequests`)

- **Keys:** `escalationId` (PK), `timestamp` (SK)
- **GSI:** `DateTimestampIndex` on `date` + `timestamp`
- **Attributes:** `date`, `name`, `email`, `phone`, `question`, `sessionId`, `status`, `ttl`

---

## Related documentation

- [Deployment Guide](./deploymentGuide.md) — How to deploy the application
- [Architecture Deep Dive](./architectureDeepDive.md) — System design and data flows
- [User Guide](./userGuide.md) — How to use the chatbot and admin dashboard
- [Modification Guide](./modificationGuide.md) — How to customize the application
