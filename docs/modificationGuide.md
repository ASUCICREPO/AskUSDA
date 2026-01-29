# Project Modification Guide

This guide is for developers who want to extend, customize, or modify the AskUSDA Chatbot.

---

## Introduction

This document explains how to modify and extend AskUSDA. Whether you want to add features, change behavior, or customize the application, it will help you navigate the codebase and make changes safely.

---

## Table of Contents

- [Project Structure Overview](#project-structure-overview)
- [Frontend Modifications](#frontend-modifications)
- [Backend Modifications](#backend-modifications)
- [Knowledge Base Modifications](#knowledge-base-modifications)
- [Changing AI/ML Models](#changing-aiml-models)
- [Database Modifications](#database-modifications)
- [Adding New API Endpoints](#adding-new-api-endpoints)
- [Best Practices](#best-practices)
- [Testing Your Changes](#testing-your-changes)
- [Common Modifications](#common-modifications)
- [Troubleshooting](#troubleshooting)

---

## Project Structure Overview

```
├── backend/
│   ├── bin/backend.ts                 # CDK app entry point
│   ├── lib/backend-stack.ts           # CDK stack (DynamoDB, OpenSearch, KB, Lambdas, APIs, Cognito)
│   └── lambda/
│       ├── websocket-handler/         # WebSocket Lambda (chat, feedback, escalation)
│       │   ├── index.js
│       │   └── package.json
│       └── admin-api/                 # Admin HTTP API Lambda (metrics, feedback, escalations)
│           ├── index.js
│           └── package.json
├── frontend/
│   ├── app/
│   │   ├── page.tsx                   # Main page with hover chatbot
│   │   ├── admin/page.tsx             # Admin login
│   │   ├── dashboard/page.tsx         # Admin dashboard (metrics, feedback, escalations)
│   │   ├── components/
│   │   │   └── ChatBot.tsx            # Hover chatbot UI, WebSocket client, citations, feedback, support modal
│   │   ├── context/
│   │   │   └── AdminAuthContext.tsx   # Cognito auth state for admin
│   │   ├── globals.css                # Global styles, CSS variables
│   │   └── layout.tsx
│   └── public/                        # Static assets (usda-symbol.svg, usda-bg.png, etc.)
└── docs/                              # Documentation
```

---

## Frontend Modifications

### Changing the UI Theme

**Location**: `frontend/app/globals.css`

The app uses CSS custom properties and Tailwind. To adjust colors:

```css
:root {
  --background: #ffffff;    /* Page background */
  --foreground: #171717;   /* Text color */
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: #0a0a0a;
    --foreground: #ededed;
  }
}
```

Tailwind v4 and `@tailwindcss/typography` are used for layout and markdown. Update `globals.css` and Tailwind config as needed.

### Changing Fonts

**Location**: `frontend/app/layout.tsx` and `frontend/app/globals.css`

The project uses **Geist** (sans and mono) by default. To change fonts, update the font imports in `layout.tsx` and any `font-family` usage in `globals.css`.

### Adding New Pages

**Location**: `frontend/app/`

Next.js uses file-based routing:

1. Create a directory: `frontend/app/your-page/`
2. Add `page.tsx`:

```tsx
// frontend/app/your-page/page.tsx
export default function YourPage() {
  return (
    <div>
      <h1>Your New Page</h1>
    </div>
  );
}
```

For **admin-only** pages, use the auth context:

```tsx
'use client';
import { useAdminAuth } from '../context/AdminAuthContext';

export default function ProtectedPage() {
  const { isAuthenticated, isLoading } = useAdminAuth();

  if (isLoading) return <div>Loading...</div>;
  if (!isAuthenticated) return <div>Access denied</div>;

  return <div>Protected content</div>;
}
```

### Modifying the Chat Interface

**Location**: `frontend/app/components/ChatBot.tsx`

- **Suggested questions**: Edit the `suggestedQuestions` array (e.g. around lines 45–50).
- **Welcome message**: Update the initial `messages` state (first bot message).
- **Support modal**: The escalation/support form is implemented inside `ChatBot.tsx`; adjust UI and submit logic there.

### Modifying Components

| Component | Purpose |
|-----------|---------|
| `ChatBot.tsx` | Hover chatbot, WebSocket chat, message list, citations, thumbs up/down, support modal |
| `AdminAuthContext.tsx` | Cognito sign-in state for admin pages |

---

## Backend Modifications

### Lambda Functions Overview

| Lambda | File | Purpose |
|--------|------|---------|
| **AskUSDA-WebSocketHandler** | `lambda/websocket-handler/index.js` | WebSocket routes: `sendMessage`, `submitFeedback`, `submitEscalation`; Bedrock KB RetrieveAndGenerate, guardrails |
| **AskUSDA-AdminHandler** | `lambda/admin-api/index.js` | HTTP Admin API: GET /metrics, GET/POST /feedback, GET/POST /escalations, DELETE /escalations/{id} |

### Adding New Lambda Functions

**Location**: `backend/lambda/`

1. Create a directory: `backend/lambda/your-function/`
2. Add `index.js` (and `package.json` if you need extra dependencies):

```javascript
// backend/lambda/your-function/index.js
exports.handler = async (event) => {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Success' }),
  };
};
```

3. In `backend/lib/backend-stack.ts`:
   - Define the Lambda with `lambda.Function`, `code: lambda.Code.fromAsset('lambda/your-function')`, and the right handler/runtime.
   - Grant DynamoDB, Bedrock, or other permissions as needed.
   - Wire it to API Gateway (HTTP or WebSocket) or EventBridge if applicable.

### Modifying the CDK Stack

**Location**: `backend/lib/backend-stack.ts`

The stack is organized roughly as:

1. **DynamoDB** (~lines 18–64): Conversation History, Escalation Requests (and GSIs).
2. **OpenSearch Serverless** (~66–90): Vector collection and index for the Knowledge Base.
3. **Bedrock Knowledge Base** (~133–197): KB definition, web crawler data source, optional KBSync Lambda + EventBridge.
4. **WebSocket Lambda** (~318–381): Handler, WebSocket API (`$connect`, `$disconnect`, `sendMessage`, `submitFeedback`, `submitEscalation`).
5. **Guardrail** (~383–412): Bedrock guardrail for content filtering.
6. **Cognito** (~414–441): Admin User Pool and app client.
7. **Admin Lambda + HTTP API** (~443–558): Admin API routes, JWT authorizer, CORS.
8. **Outputs** (~560–620): WebSocket URL, Admin API URL, table names, KB IDs, Cognito IDs, etc.

When you add resources, follow existing patterns (environments, roles, dependencies) and update outputs if new URLs or IDs need to be exposed.

---

## Knowledge Base Modifications

### Adding or Changing Web Crawler URLs

**Location**: `backend/lib/backend-stack.ts` (Web Crawler data source, ~lines 173–194)

The Knowledge Base uses a **web crawler** data source (no S3 document bucket). To add or change seed URLs:

```typescript
seedUrls: [
  { url: 'https://www.usda.gov/' },
  { url: 'https://www.farmers.gov/' },
  // Add more:
  { url: 'https://your-source.gov/' },
],
```

You can also adjust `crawlerConfiguration` (e.g. `rateLimit`, `scope`). After changes, redeploy and trigger a sync (Bedrock console or EventBridge-triggered job).

### Chunking and Ingestion

Chunking for the web crawler is handled by Bedrock default behavior. The stack does not explicitly set `chunkingConfiguration` for this data source. To change chunking or ingestion, you would need to use supported Bedrock data source options in the CDK (if available) or modify via the Bedrock console.

### Syncing the Knowledge Base

After changing data sources or URLs:

1. **AWS Console**: Bedrock → Knowledge bases → your KB → Data sources → **Sync** (or run ingestion).
2. **CLI**:

```bash
aws bedrock-agent start-ingestion-job \
  --knowledge-base-id YOUR_KB_ID \
  --data-source-id YOUR_DATA_SOURCE_ID
```

Use `KnowledgeBaseId` and `WebCrawlerDataSourceId` from the CDK outputs.

---

## Changing AI/ML Models

### Generation Model (Chat Responses)

**Location**: `backend/lambda/websocket-handler/index.js` (inside `queryKnowledgeBase`, ~lines 76–101)

The chat uses **RetrieveAndGenerate** with a Bedrock model. The model ARN and inference settings are in the `params` object:

```javascript
knowledgeBaseConfiguration: {
  knowledgeBaseId: KNOWLEDGE_BASE_ID,
  modelArn: `arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-pro-v1:0`,
  retrievalConfiguration: {
    vectorSearchConfiguration: {
      numberOfResults: 5,   // Increase for more context
    },
  },
  generationConfiguration: {
    inferenceConfig: {
      textInferenceConfig: {
        maxTokens: 2048,
        temperature: 0.7,
        topP: 0.9,
      },
    },
  },
},
```

- **Model**: Change `modelArn` to another Bedrock model (e.g. `anthropic.claude-3-sonnet-*`, `anthropic.claude-3-haiku-*`). Ensure the model supports RetrieveAndGenerate in your region.
- **Retrieval**: Adjust `numberOfResults` to change how many KB chunks are used.
- **Generation**: Tune `maxTokens`, `temperature`, and `topP` as needed.

Redeploy the WebSocket Lambda after changes.

### Embedding Model

**Location**: `backend/lib/backend-stack.ts` (~line 142)

```typescript
embeddingModelArn: `arn:aws:bedrock:${cdk.Aws.REGION}::foundation-model/amazon.titan-embed-text-v2:0`,
```

To switch to another embedding model (e.g. `amazon.titan-embed-text-v1`), update this ARN. The OpenSearch index uses **1024-dimensional** vectors (Titan Embed v2). Changing the embedding model usually requires a new index and re-ingestion; avoid changing it unless necessary.

---

## Database Modifications

### DynamoDB Tables

| Table | Purpose |
|-------|---------|
| **AskUSDA-ConversationHistory** | One record per Q&A when feedback is submitted; used for metrics and feedback list. |
| **AskUSDA-EscalationRequests** | Escalation requests from the support form / `submitEscalation`. |

**Conversation History**: `conversationId` (PK), `timestamp` (SK); GSIs on `sessionId`, `date`, `feedback`.  
**Escalation Requests**: `escalationId` (PK), `timestamp` (SK); GSI on `date` + `timestamp`.

### Adding New Tables

**Location**: `backend/lib/backend-stack.ts`

1. Define a new `dynamodb.Table` (partition key, sort key, billing mode, removal policy).
2. Add GSIs if you need to query by other attributes.
3. Grant the appropriate Lambda roles read/write access via `table.grantReadWriteData(lambdaRole)`.

### Adding Attributes

DynamoDB is schemaless. To store new fields:

1. Update the Lambda code that writes items (e.g. WebSocket handler for conversations, admin API for escalations) to include the new attributes.
2. Update any queries or projections that read them.
3. Add a GSI only if you need to query or sort by the new attribute.

---

## Adding New API Endpoints

### WebSocket Routes

**Location**: `backend/lib/backend-stack.ts` and `backend/lambda/websocket-handler/index.js`

1. **CDK**: Add a route with `webSocketApi.addRoute('yourRoute', { integration: ... })`.
2. **Lambda**: In the handler, switch on `routeKey` (or `action` for `$default`) and implement `handleYourRoute(connectionId, body)`.
3. Use `sendToClient(connectionId, payload)` to respond over the WebSocket.
4. Update `docs/APIDoc.md` with the new route and message format.

### HTTP Admin API Routes

**Location**: `backend/lib/backend-stack.ts` and `backend/lambda/admin-api/index.js`

1. **CDK**: Add a route with `adminApi.addRoutes({ path: '/your-path', methods: [...], integration: adminIntegration, authorizer?: jwtAuthorizer })`. Use `authorizer` for protected routes.
2. **Lambda**: In `admin-api/index.js`, handle the `path` and HTTP method (and query/path params), then return `response(statusCode, body)`.
3. Update `docs/APIDoc.md` with the new endpoint, request, and response.

### CORS (Admin API)

**Location**: `backend/lib/backend-stack.ts` (~lines 488–500)

CORS is configured on the HTTP API:

```typescript
corsPreflight: {
  allowOrigins: ['*'],
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: [HttpGet, HttpPost, HttpDelete, HttpOptions],
  maxAge: cdk.Duration.days(1),
},
```

Tighten `allowOrigins` or adjust headers/methods if needed.

---

## Best Practices

1. **Validate changes before deploy**: Run `cdk synth` and `cdk diff` in `backend/` before deploying.
2. **Use environment variables**: Keep config (e.g. table names, KB IDs) in Lambda env or CDK context; avoid hardcoding.
3. **Follow existing patterns**: Match naming, structure, and error handling used elsewhere in the repo.
4. **Update docs**: Keep `APIDoc.md`, `deploymentGuide.md`, and `architectureDeepDive.md` in sync with API and infra changes.
5. **Small, focused commits**: Easier to review and roll back.

**Security**: Don’t commit secrets; use IAM and least privilege for Lambdas; validate and sanitize user input.

---

## Testing Your Changes

### Frontend

```bash
cd frontend
npm install
npm run dev
# Open http://localhost:3000
```

Set `NEXT_PUBLIC_WEBSOCKET_URL` and `NEXT_PUBLIC_ADMIN_API_URL` (and Cognito vars for admin) in `.env.local` when testing against a deployed backend.

### Backend (CDK)

```bash
cd backend
npm install
cdk synth    # Validate template
cdk diff     # Preview changes
```

### Deployment

```bash
# Full pipeline (CodeBuild + Amplify)
./deploy.sh

# Or CDK only (backend)
cd backend
cdk deploy
```

Use `cdk deploy --hotswap` only when you know it’s safe (e.g. Lambda-only changes); it can skip full CloudFormation updates.

### Lambda

```bash
aws lambda invoke \
  --function-name AskUSDA-WebSocketHandler \
  --payload '{"requestContext":{"routeKey":"$connect","connectionId":"test"},"body":null}' \
  --cli-binary-format raw-in-base64-out \
  response.json
```

Adjust payload and function name for the handler you’re testing.

---

## Common Modifications

### Changing the Logo

1. Replace `frontend/public/usda-symbol.svg` with your logo (or add a new file and update references).
2. Update `src` in `frontend/app/page.tsx`, `admin/page.tsx`, `dashboard/page.tsx`, and `components/ChatBot.tsx` where the logo is used.

### Changing Suggested Questions

**Location**: `frontend/app/components/ChatBot.tsx` (~lines 45–50)

```ts
const suggestedQuestions = [
  "How do I apply for farm loans?",
  "What USDA programs are available?",
  "How to report a food safety issue?",
  "Find local USDA service centers",
  // Add or edit strings
];
```

### Adding Admin Users

Admins are managed in Cognito. Create users via the **AWS Console** (Cognito → User pools → AskUSDA-AdminPool → Users → Create user) or CLI:

```bash
aws cognito-idp admin-create-user \
  --user-pool-id YOUR_USER_POOL_ID \
  --username admin@example.com \
  --user-attributes Name=email,Value=admin@example.com \
  --temporary-password 'YourTempPassword123!'
```

Use `AdminUserPoolId` from the CDK outputs.

---

## Troubleshooting

| Issue | What to check |
|-------|----------------|
| **CORS errors** | Admin API `corsPreflight` in backend-stack; Lambda responses include required CORS headers. |
| **401 on admin routes** | Valid Cognito Id token in `Authorization`; correct User Pool and Client IDs in frontend. |
| **Chat not replying** | WebSocket URL and connectivity; KB synced; Lambda logs (WebSocket handler); Bedrock model and KB permissions. |
| **Knowledge Base empty or outdated** | Run sync for the web crawler data source; confirm seed URLs and rate limits. |
| **Lambda timeout** | Increase `timeout` for the function in the CDK stack. |

**Useful commands**:

```bash
# Tail WebSocket Lambda logs
aws logs tail /aws/lambda/AskUSDA-WebSocketHandler --follow

# Tail Admin API Lambda logs
aws logs tail /aws/lambda/AskUSDA-AdminHandler --follow

# Check KB and data source
aws bedrock-agent get-knowledge-base --knowledge-base-id YOUR_KB_ID
aws bedrock-agent list-ingestion-jobs --knowledge-base-id YOUR_KB_ID --data-source-id YOUR_DS_ID
```

---

## Conclusion

AskUSDA is built to be extended. Use this guide to modify the frontend, backend, Knowledge Base, models, and APIs safely. Keep documentation and tests up to date as you change the system.

For more detail:

- [API Documentation](./APIDoc.md)
- [Deployment Guide](./deploymentGuide.md)
- [Architecture Deep Dive](./architectureDeepDive.md)
- [User Guide](./userGuide.md)
