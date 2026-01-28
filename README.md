# AskUSDA - USDA Chatbot

AskUSDA is an AI-powered chatbot and admin dashboard that helps the public, farmers, and ranchers quickly find accurate information from USDA programs and services. It uses AWS Bedrock Knowledge Bases, a serverless backend, and a modern Next.js frontend with a hover-over chatbot experience.

---

## Visual Demo

![User Interface Demo](./docs/media/user-interface.gif)

> Please provide a GIF or screenshot of the application interface and save it as `docs/media/user-interface.gif`.

---

## Table of Contents

| Index                                               | Description                                              |
| :-------------------------------------------------- | :------------------------------------------------------- |
| [High Level Architecture](#high-level-architecture) | High level overview illustrating component interactions  |
| [Deployment Guide](#deployment-guide)               | How to deploy the project                                |
| [User Guide](#user-guide)                           | End-user instructions and walkthrough                    |
| [API Documentation](#api-documentation)             | Documentation on the APIs the project uses               |
| [Directories](#directories)                         | General project directory structure                      |
| [Modification Guide](#modification-guide)           | Guide for developers extending the project               |
| [Credits](#credits)                                 | Contributors and acknowledgments                         |
| [License](#license)                                 | License information                                      |

---

## High Level Architecture

AskUSDA uses a fully serverless architecture on AWS. A Next.js frontend (hosted on AWS Amplify) exposes a hover-over chatbot for end users and an `/admin` dashboard for analysts. The frontend connects to a WebSocket API Gateway and Lambda function for real-time chat, and to an HTTP API + Lambda for admin metrics, feedback, and escalation management. Conversation logs, feedback, and escalations are stored in DynamoDB, while AWS Bedrock (Nova Pro) and a Bedrock Knowledge Base backed by OpenSearch provide retrieval-augmented generation over USDA.gov content.

![Architecture Diagram](./docs/media/architecture.png)

> The architecture diagram should show:
> - Frontend (Next.js on Amplify) and hover-over chatbot
> - WebSocket API Gateway, Admin HTTP API Gateway, and Lambda functions
> - DynamoDB tables for `AskUSDA-ConversationLogs` and `AskUSDA-EscalationRequests`
> - AWS Bedrock models and Knowledge Base backed by OpenSearch Serverless
> - Optional Cognito authentication for the admin dashboard
> 
> Save the diagram as `docs/media/architecture.png` (or .jpeg/.jpg).

For a detailed explanation of the architecture, see the [Architecture Deep Dive](./docs/architectureDeepDive.md).

---

## Deployment Guide

For complete deployment instructions, see the [Deployment Guide](./docs/deploymentGuide.md).

**Quick Start:**
1. Deploy the backend CDK stack from the `backend/` folder (this creates the WebSocket API, Admin API, DynamoDB tables, Bedrock integrations, and required IAM roles).
2. Configure the frontend `.env.local` with `NEXT_PUBLIC_WEBSOCKET_URL` and `NEXT_PUBLIC_ADMIN_API_URL` using the outputs from the CDK deployment.
3. Deploy the frontend from the `frontend/` folder (e.g., via AWS Amplify Hosting) and open the main page to start chatting with AskUSDA.

---

## User Guide

For detailed usage instructions with screenshots, see the [User Guide](./docs/userGuide.md).

---

## API Documentation

For complete API reference, see the [API Documentation](./docs/APIDoc.md).

---

## Modification Guide

For developers looking to extend or modify this project, see the [Modification Guide](./docs/modificationGuide.md).

---

## Directories

```
├── backend/
│   ├── bin/
│   │   └── backend.ts
│   ├── lambda-bundle/
│   │   ├── index.js               # WebSocket chatbot Lambda bundle
│   │   └── admin.js               # Admin API Lambda bundle
│   ├── lib/
│   │   └── backend-stack.ts
│   ├── cdk.json
│   ├── package.json
│   └── tsconfig.json
├── frontend/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx               # Main page with background and hover chatbot
│   │   ├── admin/page.tsx         # Admin dashboard for metrics, feedback, escalations
│   │   ├── components/ChatBot.tsx # Hover-over chatbot UI and WebSocket client
│   │   └── globals.css
│   ├── public/
│   │   ├── usda-bg.png            # USDA website background image
│   │   └── usda-symbol.svg        # USDA logo used in UI
│   └── package.json
├── docs/
│   ├── architectureDeepDive.md
│   ├── deploymentGuide.md
│   ├── userGuide.md
│   ├── APIDoc.md
│   ├── modificationGuide.md
│   └── media/
│       ├── architecture.png
│       └── user-interface.gif
├── LICENSE
└── README.md
```

### Directory Explanations:

1. **backend/** - Contains all backend infrastructure and serverless functions
   - `bin/` - CDK app entry point
   - `lambda-bundle/` - Bundled AWS Lambda handlers for WebSocket chat and admin APIs
   - `lib/` - CDK stack definitions

2. **frontend/** - Next.js frontend application
   - `app/` - Next.js App Router pages and layouts
   - `public/` - Static assets

3. **docs/** - Project documentation
   - `media/` - Images, diagrams, and GIFs for documentation

---

## Credits

This application was developed by:

**Associate Cloud Developers:**

- <a href="https://www.linkedin.com/in/sreeram-sreedhar/" target="_blank">Sreeram Sreedhar</a>
- <a href="https://www.linkedin.com/in/shaashvatm156/" target="_blank">Shaashvat Mittal </a>

**UI/UX Designer:**
- <a href="https://www.linkedin.com/in/ashik-tharakan/" target="_blank">Ashik Mathew Tharakan</a>

Built in collaboration with the ASU Cloud Innovation Center and USDA stakeholders.

---

## License

This project is licensed under the MIT License - see the [LICENSE](./LICENSE) file for details.

