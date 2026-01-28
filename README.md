# AskUSDA - USDA Chatbot

AskUSDA is an intelligent AI-powered chatbot that helps  the public, farmers, and ranchers quickly find accurate information from USDA programs and services. It uses AWS Bedrock Knowledge Bases, a serverless backend, and a modern Next.js frontend with a hover-over chatbot experience.

---

## Visual Demo

![User Interface Demo](./docs/media/user-interface.gif)

> Please provide a GIF or screenshot of the application interface and save it as `docs/media/user-interface.gif`.

---

## Table of Contents

| Description           | Link                                                                 |
| --------------------- | -------------------------------------------------------------------- |
| Overview              | [Overview](#overview)                                                |
| Architecture          | [Architecture Diagram](#architecture-diagram)                        |
| Detailed Architecture | [Architecture Deep Dive](docs/architectureDeepDive.md)               |
| Deployment            | [Deployment Guide](#deployment-guide)                                |
| User Guide            | [User Guide](docs/userGuide.md)                                      |
| API Documentation     | [API Documentation](docs/APIDoc.md)                                  |
| Modification Guide    | [Modification Guide](docs/modificationGuide.md)                      |
| Credits               | [Credits](#credits)                                                  |
| License               | [License](#license)                                                  |

---

## Overview

AskUSDA is an AI-powered chatbot that helps the public, farmers, and ranchers quickly find accurate information from USDA programs and services. It enables natural-language conversations over USDA.gov content, with a hover-over chatbot on the main site and an admin dashboard for monitoring user feedback and escalations.

### Key Features

- **AI-Powered Conversations** using AWS Bedrock with Nova Pro
- **Knowledge Base Integration** with USDA.gov and farmers.gov content (web pages and PDFs) via OpenSearch Serverless
- **Real-time Streaming Responses** over WebSockets for a natural chat experience
- **Citation Support** with source references for transparency
- **Thumbs Up/Down Feedback** stored per message for analytics
- **Admin Dashboard** for metrics, conversation feedback, and escalation requests
- **Escalation Requests** with view/delete and full conversation preview
- **Hover-over Chatbot** and responsive design for desktop and mobile

---

## Architecture Diagram

![Architecture Diagram](./docs/media/architecture.png)

The application implements a serverless architecture on AWS, combining:

- **Frontend**: Next.js application hosted on AWS Amplify (main page with hover chatbot, `/admin` dashboard)
- **Backend**: AWS CDK–deployed WebSocket API + HTTP Admin API with Lambda handlers
- **AI Layer**: AWS Bedrock Knowledge Base and Nova Pro, with guardrails for filtering out harmful content and block denied topics
- **Data Storage**: DynamoDB for conversation logs, feedback, and escalation requests

For a detailed explanation of the architecture, see the [Architecture Deep Dive](docs/architectureDeepDive.md).

---

## Deployment Guide

For complete deployment instructions, see the [Deployment Guide](./docs/deploymentGuide.md).

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

