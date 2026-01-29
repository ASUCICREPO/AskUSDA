# Deployment Guide

This guide provides step-by-step instructions for deploying the AskUSDA Chatbot.

---

## Table of Contents

- [Deployment Guide](#deployment-guide)
  - [Requirements](#requirements)
  - [Common Prerequisites](#common-prerequisites)
  - [Deployment Using AWS CodeBuild and CloudShell](#deployment-using-aws-codebuild-and-cloudshell)
  - [Manual CDK Deployment](#manual-cdk-deployment)
  - [Post-Deployment Steps](#post-deployment-steps)
  - [CDK Outputs](#cdk-outputs)
  - [Troubleshooting](#troubleshooting)
  - [Cleanup](#cleanup)
  - [Next Steps](#next-steps)

---

## Requirements

### Accounts

- **AWS Account** — [Create an AWS account](https://aws.amazon.com/) if you do not have one.
- **GitHub** — The deployment uses a GitHub repository. You can use the default `ASUCICREPO/AskUSDA` or fork the repo and update the URL in `deploy.sh` (see below).

### CLI Tools (for Manual CDK Deployment)

- **AWS CLI** (v2.x) — [Install AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- **Node.js** (v18.x or later) — [Download Node.js](https://nodejs.org/)
- **AWS CDK** (v2.x) — Install via `npm install -g aws-cdk`
- **Docker** — [Install Docker](https://docs.docker.com/get-docker/) (required for CDK asset bundling)

### AWS Account Permissions

Your AWS user or role must be able to create and manage:

- CloudFormation  
- Lambda  
- API Gateway (REST and WebSocket)  
- DynamoDB  
- Bedrock (Knowledge Bases, foundation models)  
- OpenSearch Serverless  
- Cognito  
- Amplify  
- CodeBuild (when using `deploy.sh`)  
- Secrets Manager (if used)  
- IAM roles and policies  
- CloudWatch Logs  
- EventBridge  

---

## Common Prerequisites

### 1. Fork the Repository (Optional)

To deploy from your own copy of the project:

1. Open the [AskUSDA repository](https://github.com/ASUCICREPO/AskUSDA) on GitHub.  
2. Click **Fork** and choose your account.  
3. Clone your fork locally.  
4. If you use `deploy.sh`, edit `deploy.sh` and set `REPOSITORY_URL` to your fork (e.g. `https://github.com/YOUR-USERNAME/AskUSDA.git`).

### 2. GitHub Access for CodeBuild

The `deploy.sh` flow uses **CodeBuild** with a **GitHub** source. The script points to `https://github.com/ASUCICREPO/AskUSDA.git` by default.

- If the repo is **public**, CodeBuild can clone it without a token.  
- If you use a **private** fork, you must connect CodeBuild to GitHub (e.g. via OAuth or a personal access token) and update the CodeBuild project source accordingly. The `deploy.sh` script does not configure GitHub authentication itself.

### 3. Configure AWS CLI

```bash
aws configure
```

Provide:

- AWS Access Key ID  
- AWS Secret Access Key  
- Default region: `us-east-1` (recommended)  
- Default output format: `json`  

---

## Deployment Using AWS CodeBuild and CloudShell

This is the **recommended** deployment method. It uses `deploy.sh` to create an IAM role, an Amplify app, a CodeBuild project, and then run a unified build that deploys the CDK backend and builds/uploads the frontend to Amplify.

### Prerequisites

- Access to **AWS CloudShell** (or any environment with AWS CLI and `jq`).  
- AWS account with permissions for CodeBuild, Amplify, CloudFormation, and the other services listed above.

### Deployment Steps

#### 1. Open AWS CloudShell

1. Log in to the **AWS Console**.  
2. Open **CloudShell** from the console navigation bar.  
3. Wait for the environment to initialize.

#### 2. Clone the Repository

```bash
git clone https://github.com/ASUCICREPO/AskUSDA
cd AskUSDA
```

If you use your own fork, clone that URL and `cd` into the repo. Ensure `REPOSITORY_URL` in `deploy.sh` matches the cloned repo.

#### 3. Run the Deployment Script

```bash
chmod +x deploy.sh
./deploy.sh
```

The script will:

1. Create an IAM service role for CodeBuild.  
2. Create an **Amplify** app (`AskUSDA-Frontend`) and a `master` branch for static hosting.  
3. Create a **CodeBuild** project that uses the GitHub repo and `buildspec.yml`.  
4. Start a **build** that runs `cdk bootstrap`, `cdk deploy`, then builds the Next.js app and deploys it to Amplify via zip upload.

No interactive prompts are required; it uses the configuration in `deploy.sh` and `buildspec.yml`.

#### 4. Monitor the Build

1. In the AWS Console, go to **CodeBuild → Build projects**.  
2. Open the project named like `askusda-YYYYMMDDHHMMSS-deployment`.  
3. Open the running build and check the **logs**.  
4. Wait for the build to finish (typically several minutes).  

The script streams log output and prints a **Deployment Summary** when the build succeeds, including:

- **WebSocket URL**  
- **Admin API URL**  
- **Amplify App ID**  
- **Frontend URL** (e.g. `https://master.<amplify-domain>.amplifyapp.com`)  

---

## Manual CDK Deployment

Use this method if you prefer to deploy from your local machine (or a CI environment) without `deploy.sh`.

### Prerequisites

- **AWS CLI** (v2.x), **Node.js** (v18+), **AWS CDK** (v2.x), and **Docker** installed.  
- AWS credentials configured (`aws configure`).  
- Permissions as in [Requirements](#requirements).

### Deployment Steps

#### 1. Clone the Repository

```bash
git clone https://github.com/ASUCICREPO/AskUSDA
cd AskUSDA
```

#### 2. Install Backend Dependencies

```bash
cd backend
npm install
```

#### 3. Bootstrap CDK (First-Time Only)

```bash
cdk bootstrap aws://ACCOUNT_ID/REGION
```

Replace `ACCOUNT_ID` and `REGION` with your AWS account ID and region (e.g. `us-east-1`).

#### 4. Deploy the Stack

```bash
cdk deploy
```

When prompted, review IAM and resource changes, then type `y` to confirm.

The stack `AskUSDA-Backend` deploys:

- DynamoDB (Conversation History, Escalation Requests)  
- OpenSearch Serverless (vector store)  
- Bedrock Knowledge Base (web crawler data source for usda.gov, farmers.gov)  
- Lambda (WebSocket handler, Admin API)  
- API Gateway (WebSocket + HTTP Admin API)  
- Cognito User Pool for admin authentication  
- EventBridge rule for daily Knowledge Base sync  

#### 5. Build and Deploy the Frontend Separately

The CDK stack does not deploy the frontend. To run the app:

1. **Obtain stack outputs** (WebSocket URL, Admin API URL, Cognito User Pool ID, Cognito Client ID):

   ```bash
   aws cloudformation describe-stacks --stack-name AskUSDA-Backend \
     --query 'Stacks[0].Outputs' --output table
   ```

2. **Create `frontend/.env.local`** with:

   ```bash
   NEXT_PUBLIC_WEBSOCKET_URL=<WebSocketUrl>
   NEXT_PUBLIC_ADMIN_API_URL=<AdminApiUrl>
   NEXT_PUBLIC_COGNITO_USER_POOL_ID=<AdminUserPoolId>
   NEXT_PUBLIC_COGNITO_CLIENT_ID=<AdminUserPoolClientId>
   NEXT_PUBLIC_AWS_REGION=us-east-1
   ```

3. **Build and run locally** (or deploy to Amplify/Vercel/etc.):

   ```bash
   cd frontend
   npm install
   npm run build
   npm run start
   ```

   For **static export** (e.g. Amplify static hosting), the app uses `output: 'export'`. Upload the `out/` directory to your chosen host.

---

## Post-Deployment Steps

### 1. Sync the Knowledge Base

The Knowledge Base uses a **web crawler** data source (usda.gov, farmers.gov). Indexing can be triggered via the Bedrock console or the existing EventBridge daily job.

**Option A — Bedrock console**

1. Go to **AWS Console → Bedrock → Knowledge bases**.  
2. Open the knowledge base created by the stack (e.g. `AskUSDA-KnowledgeBase`).  
3. Open the web crawler data source and click **Sync** (or **Run ingestion**).  
4. Wait until the sync status is **Available**.

**Option B — EventBridge**

The stack creates an EventBridge rule that triggers a daily sync (e.g. 6:00 AM UTC). You can leave it as is or run an ingestion job manually via the Bedrock API/console.

### 2. Create an Admin User in Cognito

To sign in to the `/admin` dashboard:

1. Go to **AWS Console → Cognito → User pools**.  
2. Select the pool created by the stack (e.g. `AskUSDA-AdminPool`).  
3. Open the **Users** tab → **Create user**.  
4. Set:
   - **Username**: admin email address.  
   - **Email**: same email.  
   - **Temporary password**: a secure password.  
5. Create the user. The admin will change the password on first sign-in.

### 3. Access the Application

- **Chatbot**: Open the frontend URL (from the deploy summary or your own deployment). The main page hosts the hover-over chatbot.  
- **Admin dashboard**: Go to `https://<your-frontend-url>/admin` and sign in with the Cognito admin user.

---

## CDK Outputs

After a successful backend deployment, you can read these CloudFormation outputs (e.g. via `aws cloudformation describe-stacks` or the AWS Console):

| Output | Description |
|--------|-------------|
| `WebSocketUrl` | WebSocket API URL for the chatbot |
| `AdminApiUrl` | HTTP Admin API base URL (metrics, feedback, escalations) |
| `ConversationTableName` | DynamoDB Conversation History table |
| `EscalationTableName` | DynamoDB Escalation Requests table |
| `KnowledgeBaseId` | Bedrock Knowledge Base ID |
| `WebCrawlerDataSourceId` | Bedrock data source ID for the web crawler |
| `OpenSearchCollectionEndpoint` | OpenSearch Serverless collection endpoint |
| `GuardrailId` | Bedrock Guardrail ID |
| `AdminUserPoolId` | Cognito User Pool ID for admin |
| `AdminUserPoolClientId` | Cognito App Client ID |

When using `deploy.sh`, the **frontend** URL is printed in the Deployment Summary (e.g. `https://master.<amplify-domain>.amplifyapp.com`).

---

## Troubleshooting

### CodeBuild Errors

**Symptom**: Build fails in CodeBuild.

**What to do**:

- Open **CodeBuild → Build projects → your project → Build history → failed build** and check the logs.  
- Confirm the GitHub repo is accessible (public or correctly connected).  
- Ensure Bedrock and OpenSearch Serverless are available in your region and that your IAM role has the required permissions.

### CDK Bootstrap Error

**Symptom**: `This stack uses assets, so the toolkit stack must be deployed` or similar.

**What to do**:

```bash
cdk bootstrap aws://ACCOUNT_ID/REGION
```

Use your account ID and region (e.g. `us-east-1`).

### Permission Denied

**Symptom**: Access denied errors during `cdk deploy` or CodeBuild.

**What to do**:

- Run `aws sts get-caller-identity` and confirm the correct account.  
- Ensure your IAM user/role has permissions for CloudFormation, Lambda, API Gateway, DynamoDB, Bedrock, OpenSearch Serverless, Cognito, Amplify, CodeBuild, IAM, etc.  
- Confirm you are deploying in the intended region (`aws configure get region`).

### Knowledge Base Not Responding

**Symptom**: Chat returns empty or generic answers.

**What to do**:

1. In **Bedrock → Knowledge bases**, confirm the Knowledge Base exists and the web crawler data source has been **synced** (status **Available**).  
2. Check the WebSocket Lambda’s **CloudWatch** logs for Bedrock or OpenSearch errors.  
3. Verify the Lambda execution role has `bedrock:Retrieve`, `bedrock:RetrieveAndGenerate`, and access to the OpenSearch Serverless collection.

### Amplify Build or Upload Failed

**Symptom**: `deploy.sh` succeeds for CodeBuild but the frontend does not appear or Amplify reports a failed deployment.

**What to do**:

1. In **Amplify → App → Branch (master)**, check the deployment status and logs.  
2. When using `deploy.sh`, the frontend is built in CodeBuild and uploaded as a zip; ensure the build step completes and the upload to Amplify succeeds.  
3. Confirm the Next.js app builds successfully locally (`cd frontend && npm run build`) and that `output: 'export'` is set if you use static hosting.

---

## Cleanup

To remove the **CDK-deployed backend** (DynamoDB, Lambda, API Gateway, Bedrock resources, Cognito, etc.):

```bash
cd backend
cdk destroy
```

When prompted, confirm with `y`.

**Note**: `cdk destroy` does not delete resources created by `deploy.sh` outside CDK, such as:

- The **Amplify** app  
- The **CodeBuild** project  
- The **IAM** role used by CodeBuild  

Remove those manually in the AWS Console (or via CLI) if you want a full cleanup.

---

## Next Steps

After a successful deployment:

1. Review the [User Guide](./userGuide.md) for using the chatbot and admin dashboard.  
2. See the [API Documentation](./APIDoc.md) for WebSocket and Admin API details.  
3. Check the [Architecture Deep Dive](./architectureDeepDive.md) for design and data flows.  
4. Use the [Modification Guide](./modificationGuide.md) to customize or extend the application.
