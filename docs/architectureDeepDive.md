# Architecture Deep Dive

This document provides a detailed explanation of the AskUSDA architecture.

---

## Architecture Diagram

![Architecture Diagram](./media/architecture.png)

---

## Architecture Overview

AskUSDA is built on a fully serverless AWS architecture, designed for scalability, cost-efficiency, and ease of maintenance. The system consists of three main user flows:

1. **Visitor Chat Flow** – Users interact with the AI chatbot via a hover-over widget on the main page
2. **Admin Dashboard Flow** – Staff access metrics, conversation feedback, and escalation requests at `/admin`
3. **Knowledge Ingestion Flow** – USDA.gov and farmers.gov content is indexed via a web crawler data source

---

## Architecture Flow

### 1. User Interaction (Public, Farmers, Ranchers)

Users access the chatbot through a web interface hosted on **AWS Amplify**:

- The **Frontend** is a Next.js application (App Router) with a main page and hover-over chatbot
- The main page displays a USDA-themed background; the **ChatBot** component floats as a widget
- Users send messages over **WebSockets** and receive **streaming** responses with markdown and citations
- **Thumbs up / thumbs down** feedback is collected per assistant message and sent over the same WebSocket

### 2. WebSocket API (Chat) and HTTP API (Admin)

**Amazon API Gateway** provides two entry points:

- **WebSocket API** (`AskUSDA-WebSocket`):
  - Routes: `$connect`, `$disconnect`, `sendMessage`, `submitFeedback`, `submitEscalation`
  - All chat, feedback, and escalation traffic from the chatbot uses the WebSocket connection
  - Single Lambda (**WebSocket Handler**) handles every route

- **HTTP API** (`AskUSDA-AdminAPI`):
  - `GET /metrics` – Dashboard statistics (conversations, feedback, escalations) — **Cognito protected**
  - `GET /feedback`, `POST /feedback` – Conversation feedback list (protected) and submit (public)
  - `GET /escalations`, `POST /escalations`, `DELETE /escalations/{id}` – Escalation list/delete (protected), create (public)
  - `DELETE /feedback/{id}` – Delete a conversation and its messages (protected)
  - CORS enabled; GET and DELETE routes use Cognito JWT authorizer

### 3. WebSocket Handler Lambda (Chat + Feedback + Escalation)

The **AskUSDA-WebSocketHandler** Lambda (`lambda/websocket-handler/index.js`) implements the core chat flow:

- **Connect / Disconnect**: Logs connection; no persistence of connectionId in DynamoDB
- **sendMessage**:  
  - Validates and filters input via **Bedrock Guardrail**  
  - Sends typing indicator  
  - Calls **Bedrock Knowledge Base** (`RetrieveCommand`) for context, then **Bedrock** (`ConverseStreamCommand`) with Nova Pro for streaming generation  
  - Streams response chunks over WebSocket in buffered batches (~150ms intervals), followed by a final message with citations  
  - Returns `conversationId` and session data; conversation is **not** saved until feedback is submitted
- **submitFeedback**: Saves the conversation (question, answer, citations, feedback) to **Conversation History** keyed by `conversationId` and `timestamp`; feedback values are `pos` or `neg`
- **submitEscalation**: Writes escalation request (name, email, phone, question) to **Escalation Requests** table

### 4. Bedrock Knowledge Base

**Amazon Bedrock Knowledge Base** provides RAG:

- **Embedding model**: `amazon.titan-embed-text-v2:0` (1024 dimensions)
- **Generation model**: `amazon.nova-pro-v1:0` for streaming responses
- **Retrieve**: Fetches relevant chunks from the vector store for context
- **Optional Guardrail**: Content filtering on input and output; fail-open on errors
- Returns **citations** (source URLs) that the frontend renders with markdown

### 5. S3 Vectors

**Amazon S3 Vectors** is the vector store:

- **Vector bucket**: `askusda-vectors`  
- **Index**: `askusda-kb-index` with 1024-dimensional vectors (Titan Embed v2)
- Non-filterable metadata keys include `AMAZON_BEDROCK_TEXT` to accommodate chunk content beyond the 2KB filterable limit
- Fully managed; no cluster or scaling configuration required

### 6. Data Sources (Knowledge Base)

The Knowledge Base is populated via an **S3 data source** (`crawler-s3-v3`):

- An external **ECS Fargate web crawler** (managed by the `KBSyncHandler` Lambda) crawls USDA.gov and farmers.gov content
- Crawled content is stored in S3 (`ingestion-v3/` prefix) with `.metadata.json` sidecar files
- The Knowledge Base ingests from S3, chunking with **fixed-size** strategy (200 tokens, 15% overlap)
- Content is parsed, embedded with Titan Embed v2, and stored in S3 Vectors
- Sync can be triggered manually via the Bedrock console, the `KBSyncHandler` Lambda, or via EventBridge (daily at 6:00 AM UTC)

### 7. Admin Flow

Admins use the **`/admin`** dashboard:

1. Frontend calls **Admin HTTP API** with Cognito JWT: `GET /metrics`, `GET /feedback`, `GET /escalations`; and **DELETE** `/escalations/{id}`, `/feedback/{id}`. Public (no auth): `POST /feedback`, `POST /escalations`.
2. **AskUSDA-AdminHandler** Lambda (`lambda/admin-api/index.js`) implements each route.
3. **Metrics**: Aggregated from **Conversation History** (by date index and scan for feedback/responseTimeMs) and **Escalation Requests** (count).
4. **Feedback**: Queries **Conversation History** via `feedback-timestamp-index` (conversations with feedback); returns list with conversationId, question, answerPreview, feedback, timestamp, etc.
5. **Escalations**: List (GET), create (POST from chatbot or form), delete (DELETE by escalationId). Table keyed by `escalationId` and `timestamp`.
6. **Delete Conversation**: `DELETE /feedback/{id}` removes a conversation and all its messages from the Conversation History table.

*Cognito is integrated: GET and DELETE admin routes use a JWT authorizer; POST /feedback and POST /escalations are public for the chatbot and escalation form.*

### 8. Data Storage (DynamoDB)

Two DynamoDB tables store application data:

#### Conversation History (`AskUSDA-ConversationHistory`)

- **Keys**: `conversationId` (PK), `timestamp` (SK)
- **GSIs**: `sessionId-timestamp-index`, `date-timestamp-index`, `feedback-timestamp-index`
- **TTL**: `ttl` for automatic expiry (e.g. 90 days)
- Stores: one record per Q&A when feedback is submitted — `conversationId`, `sessionId`, `question`, `answer`, `answerPreview`, `citations`, `responseTimeMs`, `date`, `feedback` (`pos`/`neg`), `feedbackTs`
- Used for metrics, feedback list, and admin dashboard views

#### Escalation Requests (`AskUSDA-EscalationRequests`)

- **Keys**: `escalationId` (PK), `timestamp` (SK)
- **GSI**: `DateTimestampIndex` on `date` + `timestamp`
- **TTL**: `ttl` for optional expiry (e.g. 1 year)
- Stores: `name`, `email`, `phone`, `question`, `sessionId`, `status`, `date`
- Used by WebSocket (submitEscalation) and Admin API (list, delete)

---

## Cloud Services / Technology Stack

### Frontend

- **Next.js 16**: React framework with App Router
  - Main page: full-screen background image + hover-over **ChatBot**
  - **`/admin`**: Dashboard with metrics, feedback table, escalation table, modals
  - **Tailwind CSS v4** and **@tailwindcss/typography** for layout and markdown
  - **react-markdown** for rendering bot responses and admin conversation previews
  - Client-side **WebSocket** for chat; **fetch** for Admin API

- **AWS Amplify**: Frontend hosting and CI/CD
  - Builds from `frontend/` (e.g. `npm ci` + `npm run build`)
  - Env: `NEXT_PUBLIC_WEBSOCKET_URL`, `NEXT_PUBLIC_ADMIN_API_URL` from CDK outputs

### Backend Infrastructure

- **AWS CDK**: Infrastructure as Code (TypeScript)
  - Single stack defines DynamoDB, S3 Vectors, Bedrock KB, Lambdas, API Gateways, Amplify app

- **Amazon API Gateway**:
  - **WebSocket API** for chat and feedback
  - **HTTP API** for admin (CORS enabled, Cognito JWT authorizer on GET and DELETE routes)

- **AWS Lambda** (Node.js 20.x):
  - **AskUSDA-WebSocketHandler** (`lambda/websocket-handler/index.js`): WebSocket routes (sendMessage, submitFeedback, submitEscalation), Knowledge Base Retrieve + ConverseStream, guardrails, DynamoDB
  - **AskUSDA-AdminHandler** (`lambda/admin-api/index.js`): HTTP handlers for metrics, feedback, escalations
  - **AskUSDA-KBSyncHandler** (`lambda/kb-sync-handler/index.js`): Orchestrates ECS Fargate web crawler and triggers KB ingestion

### AI/ML Services

- **Amazon Bedrock**:
  - Knowledge Base with RAG over USDA/farmers.gov content
  - **Nova Pro** (`amazon.nova-pro-v1:0`) for generation
  - **Titan Embed Text v2** for embeddings
  - **Guardrail** (`AskUSDA-Guardrail`) for content filtering

- **Amazon S3 Vectors**: Vector store for Knowledge Base embeddings

### Data Storage

- **Amazon DynamoDB**:
  - **Conversation History**: Chat feedback records, metrics, session data
  - **Escalation Requests**: Admin-managed escalation records
  - Pay-per-request billing; TTL where used

### Security & Authentication

- **IAM**: Least-privilege roles for Lambdas (DynamoDB, Bedrock, Knowledge Base, S3 Vectors, Execute API)
- **Cognito**: Admin User Pool (`AskUSDA-AdminPool`) with JWT authorizer on GET /metrics, GET /feedback, GET /escalations, DELETE /escalations/{id}, DELETE /feedback/{id}. POST /feedback and POST /escalations are public.
- **Secrets Manager**: Used for Amplify GitHub token (`usda-token`), not for app runtime secrets.

---

## Infrastructure as Code

This project uses **AWS CDK** to define and deploy infrastructure.

### CDK Stack Structure

```
backend/
├── bin/
│   └── backend.ts              # CDK app entry point
├── lib/
│   └── backend-stack.ts        # Main stack definition
├── lambda/
│   ├── websocket-handler/
│   │   ├── index.js            # WebSocket handler (chat, feedback, escalation)
│   │   └── package.json
│   ├── admin-api/
│   │   ├── index.js            # Admin HTTP API handler
│   │   └── package.json
│   └── kb-sync-handler/
│       ├── index.js            # KB sync orchestrator (web crawler + ingestion)
│       └── package.json
├── cdk.json
├── package.json
└── tsconfig.json
```

### Key CDK Constructs

1. **DynamoDB Table** (`aws-cdk-lib/aws-dynamodb`)
   - `ConversationLogs` and `EscalationRequests` with GSIs and TTL

2. **S3 Vectors** (`AWS::S3Vectors::VectorBucket` + `AWS::S3Vectors::Index` via `cdk.CfnResource`)
   - Vector bucket `askusda-vectors` and index `askusda-kb-index`

3. **CfnKnowledgeBase** (`aws-cdk-lib/aws-bedrock`)
   - Bedrock Knowledge Base with Titan embeddings and S3 Vectors storage

4. **CfnDataSource** (`aws-cdk-lib/aws-bedrock`)
   - S3 data source (`crawler-s3-v3`) pointing to the web crawler output bucket (`ingestion-v3/` prefix)

5. **CfnGuardrail** (`aws-cdk-lib/aws-bedrock`)
   - Content filters for input/output

6. **WebSocketApi** / **WebSocketStage** (`aws-cdk-lib/aws-apigatewayv2`)
   - WebSocket API with connect, disconnect, sendMessage, submitFeedback, submitEscalation routes

7. **HttpApi** (`aws-cdk-lib/aws-apigatewayv2`)
   - Admin HTTP API with /metrics, /feedback, /escalations, /escalations/{id}, /feedback/{id}; JWT authorizer on GET/DELETE

8. **Function** (`aws-cdk-lib/aws-lambda`)
   - WebSocket, Admin, and KBSync Lambdas pointing at `lambda/websocket-handler`, `lambda/admin-api`, and `lambda/kb-sync-handler`

9. **CfnApp** / **CfnBranch** (`aws-cdk-lib/aws-amplify`)
    - Amplify app and branch with build spec and env vars

### Deployment Automation

- **Amplify**: Builds and deploys frontend on git push; uses CDK outputs for WebSocket and Admin API URLs.
- **CDK**: Deploy via `cdk deploy` (or your chosen CI); stack creates all backend resources.

---

## Security Considerations

### Authentication

- **Admin Dashboard**: GET and DELETE admin routes require Cognito JWT (Authorization header). POST /feedback and POST /escalations are public.
- **Chat / Feedback / Escalation**: No user auth; identified by WebSocket `connectionId` only.

### Authorization

- **IAM**: Lambda roles scoped to required services (DynamoDB, Bedrock, S3 Vectors, API Gateway).
- **API Gateway**: No authorizers; WebSocket and Admin APIs are publicly reachable.

### Data Encryption

- **At rest**: DynamoDB and S3 Vectors use default encryption.
- **In transit**: HTTPS/WSS for all client traffic.

### Network Security

- **CORS**: Admin API allows configured origins.
- **S3 Vectors**: Data plane access via IAM; no VPC required.

### Data Privacy

- **Conversation History**: Stores Q&A with feedback for analytics and admin views; consider PII and retention policy.
- **Escalation Requests**: Include name, email, phone, question; handle per USDA privacy requirements.

---

## Scalability

### Auto-scaling

- **Lambda**: Concurrency scales automatically with demand.
- **DynamoDB**: Pay-per-request; no provisioned capacity.
- **S3 Vectors**: Fully managed; no scaling configuration needed.
- **API Gateway**: Managed scaling for WebSocket and HTTP APIs.

### Performance Optimizations

- **Streaming**: Chat responses streamed over WebSocket to reduce perceived latency.
- **Projections / Filters**: Admin Lambda uses GSIs (date, feedback) and projections to limit DynamoDB reads.
- **Feedback**: Admin lists conversations with feedback via `feedback-timestamp-index`; no separate “get by conversationId” endpoint in current implementation.

### Cost Optimization

- **Serverless**: Pay for actual usage.
- **DynamoDB on-demand**: No provisioned RCU/WCU.
- **S3 Vectors**: No cluster management; pay-per-query pricing.

---

## Data Flow Diagrams

### Chat Request Flow

```
User → Amplify (Frontend) → WebSocket API → WebSocket Handler Lambda
                                                      ↓
                                              Guardrail (input)
                                                      ↓
                                              Bedrock Knowledge Base (Retrieve)
                                                      ↓
                                              S3 Vectors (vector search) + ConverseStream (Nova Pro)
                                                      ↓
                                              Streaming response chunks → User
                                                      ↓
                                              Final message (answer, citations, conversationId) → User
                                                      ↓
                                              (Conversation saved to DynamoDB only when user submits feedback via submitFeedback)
```

### Feedback Flow

```
User (thumbs up/down) → WebSocket (submitFeedback) → WebSocket Handler Lambda
                                                              ↓
                                                    Save feedback + conversation → DynamoDB (Conversation History)
                                                              ↓
                                                    feedbackReceived → User
```

### Admin Dashboard Flow

```
Admin → Amplify (/admin) → HTTP API (GET /metrics, /feedback, /escalations)
                                    ↓
                          Admin Handler Lambda
                                    ↓
                          DynamoDB (Conversation History, Escalation Requests)
                                    ↓
                          JSON response → Admin (metrics, tables, modals)
```

### Knowledge Ingestion Flow

```
Web Crawler (ECS Fargate) → S3 (ingestion-v3/)
                    ↓
         Bedrock Data Source ingest
                    ↓
         Fixed-size Chunking (200 tokens) + Titan Embeddings
                    ↓
         S3 Vectors (vector index)
```

---

## Related Documentation

- [Deployment Guide](./deploymentGuide.md) – How to deploy the application
- [API Documentation](./APIDoc.md) – WebSocket and Admin API reference
- [Modification Guide](./modificationGuide.md) – How to customize the application
- [User Guide](./userGuide.md) – How to use the chatbot and admin dashboard
