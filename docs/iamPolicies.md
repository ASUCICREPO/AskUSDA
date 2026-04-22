# IAM Policies Reference

This document describes the minimum IAM permissions required to deploy AskUSDA end-to-end using `deploy.sh`. There are two distinct permission layers:

1. **Deployer User** — the IAM user or role that runs `deploy.sh` from a terminal or CloudShell
2. **CodeBuild Service Role** — the role that `deploy.sh` creates automatically for CodeBuild to perform the actual CDK deployment

---

## Table of Contents

- [Deployer User Policy](#deployer-user-policy)
- [CodeBuild Service Role Policies](#codebuild-service-role-policies)
  - [Policy 1: CloudFormation and CDK Bootstrap](#policy-1-cloudformation-and-cdk-bootstrap)
  - [Policy 2: IAM Management](#policy-2-iam-management)
  - [Policy 3: Compute and Data](#policy-3-compute-and-data)
  - [Policy 4: AI and Search](#policy-4-ai-and-search)
  - [Policy 5: ECS and VPC](#policy-5-ecs-and-vpc)
  - [Policy 6: Amplify Deployment](#policy-6-amplify-deployment)
- [CDK Runtime Roles](#cdk-runtime-roles)
- [Setup Instructions](#setup-instructions)
- [Notes](#notes)

---

## Deployer User Policy

The person running `deploy.sh` only needs permissions to orchestrate the deployment — they never touch CDK, CloudFormation, Lambda, or Bedrock directly. All infrastructure provisioning happens inside CodeBuild.

Replace `<ACCOUNT_ID>` and `<REGION>` with your values.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "STS",
      "Effect": "Allow",
      "Action": "sts:GetCallerIdentity",
      "Resource": "*"
    },
    {
      "Sid": "IAMCodeBuildRole",
      "Effect": "Allow",
      "Action": [
        "iam:GetRole",
        "iam:CreateRole",
        "iam:PutRolePolicy",
        "iam:PassRole"
      ],
      "Resource": "arn:aws:iam::<ACCOUNT_ID>:role/askusda-*"
    },
    {
      "Sid": "AmplifyManagement",
      "Effect": "Allow",
      "Action": [
        "amplify:ListApps",
        "amplify:CreateApp",
        "amplify:GetApp",
        "amplify:GetBranch",
        "amplify:CreateBranch"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CodeBuildManagement",
      "Effect": "Allow",
      "Action": [
        "codebuild:CreateProject",
        "codebuild:StartBuild",
        "codebuild:BatchGetBuilds"
      ],
      "Resource": "arn:aws:codebuild:<REGION>:<ACCOUNT_ID>:project/askusda-*"
    },
    {
      "Sid": "CloudWatchLogsRead",
      "Effect": "Allow",
      "Action": [
        "logs:GetLogEvents",
        "logs:DescribeLogStreams"
      ],
      "Resource": "arn:aws:logs:<REGION>:<ACCOUNT_ID>:log-group:/aws/codebuild/askusda-*:*"
    }
  ]
}
```

**What each permission does:**

| Action | Why |
|---|---|
| `sts:GetCallerIdentity` | `deploy.sh` reads the AWS account ID |
| `iam:GetRole` | Checks if the CodeBuild service role already exists |
| `iam:CreateRole` | Creates the CodeBuild service role |
| `iam:PutRolePolicy` | Attaches scoped policies to the CodeBuild service role |
| `iam:PassRole` | Assigns the service role to the CodeBuild project |
| `amplify:ListApps` | Checks if the Amplify app already exists |
| `amplify:CreateApp` | Creates the Amplify static hosting app |
| `amplify:GetApp/GetBranch` | Reads app and branch info |
| `amplify:CreateBranch` | Creates the master branch for deployment |
| `codebuild:CreateProject` | Creates the CodeBuild project |
| `codebuild:StartBuild` | Starts the deployment build |
| `codebuild:BatchGetBuilds` | Polls build status during log streaming |
| `logs:GetLogEvents` | Streams build logs to the terminal |
| `logs:DescribeLogStreams` | Finds the log stream for the build |

---

## CodeBuild Service Role Policies

The `deploy.sh` script automatically creates a CodeBuild service role named `askusda-<timestamp>-service-role` and attaches six scoped policies. These are the permissions CodeBuild uses to run `cdk bootstrap`, `cdk deploy`, build the frontend, and deploy to Amplify.

### Policy 1: CloudFormation and CDK Bootstrap

Manages the three CloudFormation stacks (`CDKToolkit`, `AskUSDA-Crawler`, `AskUSDA-Backend`) and CDK staging assets.

| Sid | Actions | Resource | Purpose |
|---|---|---|---|
| CloudFormationDeploy | CreateStack, UpdateStack, DeleteStack, DescribeStacks, DescribeStackEvents, DescribeEvents, DescribeStackResources, GetTemplate, GetTemplateSummary, ListStacks, CreateChangeSet, DeleteChangeSet, DescribeChangeSet, ExecuteChangeSet, ListChangeSets, ValidateTemplate | `stack/AskUSDA-Backend/*`, `stack/AskUSDA-Crawler/*`, `stack/CDKToolkit/*` | CDK deploy and bootstrap |
| CloudFormationReadGlobal | ListStacks, GetTemplateSummary, ValidateTemplate | `*` | AWS requires `*` for these list/read operations |
| CDKStagingBucket | S3 CRUD operations | `cdk-*-assets-<ACCOUNT>-<REGION>` | CDK asset staging bucket |
| CDKBootstrapSSM | ssm:GetParameter, PutParameter, GetParameters | `parameter/cdk-bootstrap/*` | CDK version tracking |
| CDKBootstrapECR | ECR repository and image operations | `repository/cdk-*` | Docker image assets for CDK |
| ECRAuthToken | ecr:GetAuthorizationToken | `*` | AWS requires `*` for auth tokens |
| STSAccess | sts:GetCallerIdentity, sts:AssumeRole | `role/cdk-*` | CDK assumes bootstrap roles |

### Policy 2: IAM Management

Creates and manages IAM roles for the CDK stacks.

| Sid | Actions | Resource | Purpose |
|---|---|---|---|
| IAMRolesForStack | CreateRole, DeleteRole, GetRole, UpdateRole, TagRole, UntagRole, PutRolePolicy, GetRolePolicy, DeleteRolePolicy, AttachRolePolicy, DetachRolePolicy, ListRolePolicies, ListAttachedRolePolicies, ListRoleTags, PassRole, CreateServiceLinkedRole | `role/AskUSDA-*`, `role/cdk-*` | Lambda execution roles, KB role, ECS roles |
| IAMPolicyManagement | CreatePolicy, DeletePolicy, GetPolicy, CreatePolicyVersion, DeletePolicyVersion, ListPolicyVersions, GetPolicyVersion | `policy/AskUSDA-*` | Managed policies for stack resources |

### Policy 3: Compute and Data

Manages Lambda functions, DynamoDB tables, API Gateway, Cognito, and CloudWatch Logs.

| Sid | Resource Scope | Purpose |
|---|---|---|
| LambdaManagement | `function:AskUSDA-*` | Three Lambda functions (WebSocket, KBSync, Admin) |
| DynamoDBManagement | `table/AskUSDA-*` | ConversationHistory and EscalationRequests tables |
| APIGatewayManagement | `arn:aws:apigateway:<REGION>::/*` | WebSocket and HTTP API Gateway |
| CognitoManagement | `userpool/*` | Admin authentication user pool |
| CloudWatchLogsManagement | `/aws/lambda/AskUSDA-*`, `/aws/codebuild/*`, `/ecs/askusda-*` | Log groups for all services |

### Policy 4: AI and Search

Manages Bedrock Knowledge Base, Guardrails, and S3 Vectors.

| Sid | Actions | Resource | Purpose |
|---|---|---|---|
| BedrockKBManagement | CreateKnowledgeBase, DeleteKnowledgeBase, GetKnowledgeBase, UpdateKnowledgeBase, CreateDataSource, DeleteDataSource, GetDataSource, UpdateDataSource, TagResource, UntagResource, ListTagsForResource | `knowledge-base/*` | Knowledge Base and data source lifecycle |
| BedrockGuardrailManagement | CreateGuardrail, DeleteGuardrail, GetGuardrail, UpdateGuardrail, ListGuardrails, CreateGuardrailVersion, TagResource, UntagResource, ListTagsForResource | `guardrail/*` | Content filtering guardrail |
| BedrockFoundationModelRead | GetFoundationModel, ListFoundationModels | `*` | AWS requires `*` for model listing |
| S3VectorsManagement | CreateVectorBucket, DeleteVectorBucket, GetVectorBucket, ListVectorBuckets, CreateIndex, DeleteIndex, GetIndex, ListIndexes, TagResource, UntagResource, ListTagsForResource | `*` | S3 Vectors infrastructure management |

### Policy 5: ECS and VPC

Manages the web crawler infrastructure.

| Sid | Resource | Purpose |
|---|---|---|
| ECSClusterManagement | `cluster/askusda-*` | ECS Fargate cluster |
| ECSTaskDefinitionManagement | `*` (AWS requirement) | Task definition registration |
| ECSContainerInsights | `*` (AWS requirement) | Container Insights account setting |
| VPCManagement | `*` (AWS requirement for EC2) | VPC, subnets, route tables, security groups, internet gateway |
| S3CrawlerBucket | `askusda-crawler-*`, `webcrawlerstack-*` | Web crawler data bucket |

### Policy 6: Amplify Deployment

Dynamically scoped to the specific Amplify app created in Phase 2.

| Sid | Actions | Resource | Purpose |
|---|---|---|---|
| AmplifyDeployment | CreateDeployment, StartDeployment, GetApp, GetBranch | `apps/<APP_ID>/*` | Frontend deployment from CodeBuild |

---

## CDK Runtime Roles

These roles are created by CDK within the CloudFormation stacks. They are the roles used by the running application (not during deployment).

### Knowledge Base Role (assumed by `bedrock.amazonaws.com`)

| Action | Resource | Purpose |
|---|---|---|
| `bedrock:InvokeModel` | `foundation-model/amazon.titan-embed-text-v2:0` | Document embedding |
| `bedrock:InvokeModel` | `foundation-model/amazon.rerank-v1:0` | Search result reranking |
| `s3vectors:GetIndex`, `PutVectors`, `GetVectors`, `DeleteVectors`, `QueryVectors`, `ListVectors` | `bucket/askusda-vectors/*` | Vector store operations |
| `s3:GetObject`, `s3:ListBucket` | Crawler data bucket | Read source documents |

### WebSocket Lambda Role

| Action | Resource | Purpose |
|---|---|---|
| DynamoDB read/write | ConversationHistory, EscalationRequests tables | Store conversations and escalations |
| `s3:GetObject`, `s3:ListBucket` | Crawler data bucket | Resolve source URLs from metadata |
| `bedrock:InvokeModel`, `InvokeModelWithResponseStream` | `foundation-model/amazon.nova-pro-v1:0` (all regions `*`), `amazon.titan-embed-text-v2:0` (deploy region) | LLM inference and embedding. Nova Pro uses `*` region because the cross-region inference profile routes to multiple US regions. |
| `bedrock:InvokeModel`, `InvokeModelWithResponseStream`, `GetInferenceProfile` | `inference-profile/us.amazon.nova-pro-v1:0` (deploy region) | Cross-region inference profile |
| `bedrock:Retrieve` | Specific Knowledge Base ARN | RAG retrieval |
| `bedrock:InvokeModel` | `foundation-model/amazon.rerank-v1:0` | Reranking |
| `bedrock:ApplyGuardrail` | Specific Guardrail ARN | Content filtering |
| `execute-api:ManageConnections` | `<API_ID>/prod/POST/@connections/*` | Send WebSocket messages to clients |

### KB Sync Lambda Role

| Action | Resource | Purpose |
|---|---|---|
| `bedrock:StartIngestionJob` | Specific Knowledge Base ARN | Trigger data source ingestion |
| `s3:GetObject`, `PutObject`, `ListBucket` | Crawler data bucket | Copy crawler output to ingestion prefix |
| `ecs:RunTask` | Specific task definition ARN | Launch crawler ECS tasks |
| `iam:PassRole` | Task role + Execution role ARNs | Pass roles to ECS |

### Admin Lambda Role

| Action | Resource | Purpose |
|---|---|---|
| DynamoDB read/write | ConversationHistory, EscalationRequests tables | Dashboard metrics, feedback, escalations |

### Crawler Task Role (assumed by `ecs-tasks.amazonaws.com`)

| Action | Resource | Purpose |
|---|---|---|
| S3 read/write | Crawler bucket `jobs/*` prefix | Write crawled data |
| `lambda:InvokeFunction` | `function:AskUSDA-KBSyncHandler` | Trigger ingestion after crawl |

---

## Setup Instructions

To create a deployer user with minimum permissions:

```bash
# 1. Create the user
aws iam create-user --user-name AskUSDA-Deployer

# 2. Save the policy above as a file (replace <ACCOUNT_ID> and <REGION>)
# Then attach it:
aws iam put-user-policy \
  --user-name AskUSDA-Deployer \
  --policy-name AskUSDA-DeployerPolicy \
  --policy-document file://deployer-policy.json

# 3. Create access keys
aws iam create-access-key --user-name AskUSDA-Deployer

# 4. Configure a profile with those credentials
aws configure set aws_access_key_id <KEY_ID> --profile askusda-deployer
aws configure set aws_secret_access_key <SECRET_KEY> --profile askusda-deployer
aws configure set region us-west-2 --profile askusda-deployer

# 5. Deploy
AWS_PROFILE=askusda-deployer AWS_REGION=us-west-2 ./deploy.sh
```

---

## Notes

- **Resource `*` usage**: Some AWS APIs require `Resource: "*"` (e.g., `ecr:GetAuthorizationToken`, `ecs:RegisterTaskDefinition`, EC2 VPC operations, `bedrock:ListFoundationModels`). These cannot be scoped further due to AWS limitations.
- **Cross-region inference profiles**: The `us.amazon.nova-pro-v1:0` inference profile routes requests across multiple US regions (us-east-1, us-west-2, etc.). The foundation model ARN for Nova Pro must use `*` for the region (`arn:aws:bedrock:*::foundation-model/amazon.nova-pro-v1:0`) or the request will be denied when routed to a different region. Titan Embed and Rerank are called directly (not via inference profile) and remain scoped to the deploy region.
- **No admin access**: Neither the deployer user nor the CodeBuild role have `AdministratorAccess`. All permissions follow least-privilege scoping.
- **Role naming convention**: All stack-created roles start with `AskUSDA-` and all CDK roles start with `cdk-`. The CodeBuild service role starts with `askusda-<timestamp>-`.
- **Bedrock model access**: Before deploying, ensure the AWS account has requested access to the following Bedrock foundation models via the AWS Console: `amazon.nova-pro-v1:0`, `amazon.titan-embed-text-v2:0`, and `amazon.rerank-v1:0`.
- **Docker base image**: The crawler Dockerfile uses `public.ecr.aws/docker/library/python:3.11-slim` (AWS ECR Public Gallery) instead of Docker Hub to avoid rate-limiting during CodeBuild.
- **CodeBuild architecture**: CodeBuild uses a `LINUX_CONTAINER` (x86_64) environment because the crawler Docker image targets `linux/amd64` for Fargate compatibility.
- **Fresh account prerequisite**: If the CDK has never been bootstrapped in the target region, `deploy.sh` handles it automatically. If a previous bootstrap left orphaned resources (S3 bucket, stale CloudFormation stack), clean them up before deploying.
