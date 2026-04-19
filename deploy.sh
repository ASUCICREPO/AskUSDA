#!/bin/bash
# Complete End-to-End Deployment Pipeline for AskUSDA
# Uses single unified CodeBuild project for backend and frontend

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
NC='\033[0m' # No Color

# Configuration
TIMESTAMP=$(date +%Y%m%d%H%M%S)
PROJECT_NAME="askusda-${TIMESTAMP}"
STACK_NAME="AskUSDA-Backend"
AWS_REGION=${AWS_REGION:-$(aws configure get region || echo "us-east-1")}
AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AMPLIFY_APP_NAME="AskUSDA-Frontend"
CODEBUILD_PROJECT_NAME="${PROJECT_NAME}-deployment"
REPOSITORY_URL="https://github.com/ASUCICREPO/AskUSDA.git" # IMPORTANT: repo url from which codebuild runs

# Global variables
WEBSOCKET_URL=""
AMPLIFY_APP_ID=""
AMPLIFY_URL=""
ROLE_ARN=""

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
    exit 1
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_codebuild() {
    echo -e "${PURPLE}[CODEBUILD]${NC} $1"
}

print_amplify() {
    echo -e "${PURPLE}[AMPLIFY]${NC} $1"
}

# --- Phase 1: Create IAM Service Role ---
print_status "🔐 Phase 1: Creating IAM Service Role..."

ROLE_NAME="${PROJECT_NAME}-service-role"
print_status "Checking for IAM role: $ROLE_NAME"

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
    print_success "IAM role exists"
    ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text)
else
    print_status "Creating IAM role: $ROLE_NAME"
    TRUST_DOC='{
      "Version":"2012-10-17",
      "Statement":[{
        "Effect":"Allow",
        "Principal":{"Service":"codebuild.amazonaws.com"},
        "Action":"sts:AssumeRole"
      }]
    }'

    ROLE_ARN=$(aws iam create-role \
      --role-name "$ROLE_NAME" \
      --assume-role-policy-document "$TRUST_DOC" \
      --query 'Role.Arn' --output text)

    print_status "Attaching scoped deployment policies..."

    # --- Policy 1: CloudFormation + CDK Bootstrap ---
    # CDK bootstrap and deploy need full CloudFormation access on the specific stack
    # plus the CDKToolkit bootstrap stack, and S3/SSM/ECR for CDK staging assets.
    CFN_POLICY='{
      "Version": "2012-10-17",
      "Statement": [
          {
              "Sid": "CloudFormationDeploy",
              "Effect": "Allow",
              "Action": [
                  "cloudformation:CreateStack",
                  "cloudformation:UpdateStack",
                  "cloudformation:DeleteStack",
                  "cloudformation:DescribeStacks",
                  "cloudformation:DescribeStackEvents",
                  "cloudformation:DescribeStackResources",
                  "cloudformation:GetTemplate",
                  "cloudformation:GetTemplateSummary",
                  "cloudformation:ListStacks",
                  "cloudformation:CreateChangeSet",
                  "cloudformation:DeleteChangeSet",
                  "cloudformation:DescribeChangeSet",
                  "cloudformation:ExecuteChangeSet",
                  "cloudformation:ListChangeSets",
                  "cloudformation:ValidateTemplate"
              ],
              "Resource": [
                  "arn:aws:cloudformation:'"$AWS_REGION"':'"$AWS_ACCOUNT_ID"':stack/AskUSDA-Backend/*",
                  "arn:aws:cloudformation:'"$AWS_REGION"':'"$AWS_ACCOUNT_ID"':stack/CDKToolkit/*"
              ]
          },
          {
              "Sid": "CloudFormationReadGlobal",
              "Effect": "Allow",
              "Action": [
                  "cloudformation:ListStacks",
                  "cloudformation:GetTemplateSummary",
                  "cloudformation:ValidateTemplate"
              ],
              "Resource": "*"
          },
          {
              "Sid": "CDKStagingBucket",
              "Effect": "Allow",
              "Action": [
                  "s3:CreateBucket",
                  "s3:PutBucketPolicy",
                  "s3:PutBucketVersioning",
                  "s3:PutEncryptionConfiguration",
                  "s3:PutLifecycleConfiguration",
                  "s3:PutBucketPublicAccessBlock",
                  "s3:GetBucketLocation",
                  "s3:GetBucketPolicy",
                  "s3:ListBucket",
                  "s3:GetObject",
                  "s3:PutObject",
                  "s3:DeleteObject"
              ],
              "Resource": [
                  "arn:aws:s3:::cdk-*-assets-'"$AWS_ACCOUNT_ID"'-'"$AWS_REGION"'",
                  "arn:aws:s3:::cdk-*-assets-'"$AWS_ACCOUNT_ID"'-'"$AWS_REGION"'/*"
              ]
          },
          {
              "Sid": "CDKBootstrapSSM",
              "Effect": "Allow",
              "Action": [
                  "ssm:GetParameter",
                  "ssm:PutParameter",
                  "ssm:GetParameters"
              ],
              "Resource": "arn:aws:ssm:'"$AWS_REGION"':'"$AWS_ACCOUNT_ID"':parameter/cdk-bootstrap/*"
          },
          {
              "Sid": "CDKBootstrapECR",
              "Effect": "Allow",
              "Action": [
                  "ecr:CreateRepository",
                  "ecr:DescribeRepositories",
                  "ecr:SetRepositoryPolicy",
                  "ecr:PutLifecyclePolicy",
                  "ecr:GetLifecyclePolicy",
                  "ecr:PutImage",
                  "ecr:BatchGetImage",
                  "ecr:GetDownloadUrlForLayer",
                  "ecr:InitiateLayerUpload",
                  "ecr:UploadLayerPart",
                  "ecr:CompleteLayerUpload",
                  "ecr:BatchCheckLayerAvailability",
                  "ecr:GetAuthorizationToken"
              ],
              "Resource": "arn:aws:ecr:'"$AWS_REGION"':'"$AWS_ACCOUNT_ID"':repository/cdk-*"
          },
          {
              "Sid": "ECRAuthToken",
              "Effect": "Allow",
              "Action": "ecr:GetAuthorizationToken",
              "Resource": "*"
          },
          {
              "Sid": "STSAccess",
              "Effect": "Allow",
              "Action": ["sts:GetCallerIdentity", "sts:AssumeRole"],
              "Resource": [
                  "arn:aws:iam::'"$AWS_ACCOUNT_ID"':role/cdk-*"
              ]
          }
      ]
    }'

    aws iam put-role-policy \
      --role-name "$ROLE_NAME" \
      --policy-name "CloudFormationAndCDKPolicy" \
      --policy-document "$CFN_POLICY"

    # --- Policy 2: IAM (scoped to CDK and stack roles only) ---
    IAM_POLICY='{
      "Version": "2012-10-17",
      "Statement": [
          {
              "Sid": "IAMRolesForStack",
              "Effect": "Allow",
              "Action": [
                  "iam:CreateRole",
                  "iam:DeleteRole",
                  "iam:GetRole",
                  "iam:UpdateRole",
                  "iam:TagRole",
                  "iam:UntagRole",
                  "iam:PutRolePolicy",
                  "iam:GetRolePolicy",
                  "iam:DeleteRolePolicy",
                  "iam:AttachRolePolicy",
                  "iam:DetachRolePolicy",
                  "iam:ListRolePolicies",
                  "iam:ListAttachedRolePolicies",
                  "iam:ListRoleTags",
                  "iam:PassRole",
                  "iam:CreateServiceLinkedRole"
              ],
              "Resource": [
                  "arn:aws:iam::'"$AWS_ACCOUNT_ID"':role/AskUSDA-*",
                  "arn:aws:iam::'"$AWS_ACCOUNT_ID"':role/cdk-*"
              ]
          },
          {
              "Sid": "IAMPolicyManagement",
              "Effect": "Allow",
              "Action": [
                  "iam:CreatePolicy",
                  "iam:DeletePolicy",
                  "iam:GetPolicy",
                  "iam:CreatePolicyVersion",
                  "iam:DeletePolicyVersion",
                  "iam:ListPolicyVersions",
                  "iam:GetPolicyVersion"
              ],
              "Resource": "arn:aws:iam::'"$AWS_ACCOUNT_ID"':policy/AskUSDA-*"
          }
      ]
    }'

    aws iam put-role-policy \
      --role-name "$ROLE_NAME" \
      --policy-name "IAMPolicy" \
      --policy-document "$IAM_POLICY"

    # --- Policy 3: Compute & Data (Lambda, DynamoDB, API Gateway, Cognito, Events) ---
    COMPUTE_POLICY='{
      "Version": "2012-10-17",
      "Statement": [
          {
              "Sid": "LambdaManagement",
              "Effect": "Allow",
              "Action": [
                  "lambda:CreateFunction",
                  "lambda:DeleteFunction",
                  "lambda:GetFunction",
                  "lambda:GetFunctionConfiguration",
                  "lambda:UpdateFunctionCode",
                  "lambda:UpdateFunctionConfiguration",
                  "lambda:AddPermission",
                  "lambda:RemovePermission",
                  "lambda:GetPolicy",
                  "lambda:ListTags",
                  "lambda:TagResource",
                  "lambda:UntagResource",
                  "lambda:PutFunctionEventInvokeConfig",
                  "lambda:DeleteFunctionEventInvokeConfig",
                  "lambda:GetFunctionEventInvokeConfig",
                  "lambda:InvokeFunction",
                  "lambda:PublishVersion",
                  "lambda:CreateAlias",
                  "lambda:DeleteAlias",
                  "lambda:UpdateAlias"
              ],
              "Resource": "arn:aws:lambda:'"$AWS_REGION"':'"$AWS_ACCOUNT_ID"':function:AskUSDA-*"
          },
          {
              "Sid": "DynamoDBManagement",
              "Effect": "Allow",
              "Action": [
                  "dynamodb:CreateTable",
                  "dynamodb:DeleteTable",
                  "dynamodb:DescribeTable",
                  "dynamodb:UpdateTable",
                  "dynamodb:DescribeTimeToLive",
                  "dynamodb:UpdateTimeToLive",
                  "dynamodb:TagResource",
                  "dynamodb:UntagResource",
                  "dynamodb:ListTagsOfResource",
                  "dynamodb:DescribeContinuousBackups"
              ],
              "Resource": [
                  "arn:aws:dynamodb:'"$AWS_REGION"':'"$AWS_ACCOUNT_ID"':table/AskUSDA-*"
              ]
          },
          {
              "Sid": "APIGatewayManagement",
              "Effect": "Allow",
              "Action": [
                  "apigateway:GET",
                  "apigateway:POST",
                  "apigateway:PUT",
                  "apigateway:PATCH",
                  "apigateway:DELETE",
                  "apigateway:TagResource",
                  "apigateway:UntagResource"
              ],
              "Resource": [
                  "arn:aws:apigateway:'"$AWS_REGION"'::/*"
              ]
          },
          {
              "Sid": "CognitoManagement",
              "Effect": "Allow",
              "Action": [
                  "cognito-idp:CreateUserPool",
                  "cognito-idp:DeleteUserPool",
                  "cognito-idp:DescribeUserPool",
                  "cognito-idp:UpdateUserPool",
                  "cognito-idp:CreateUserPoolClient",
                  "cognito-idp:DeleteUserPoolClient",
                  "cognito-idp:DescribeUserPoolClient",
                  "cognito-idp:UpdateUserPoolClient",
                  "cognito-idp:TagResource",
                  "cognito-idp:UntagResource",
                  "cognito-idp:ListTagsForResource"
              ],
              "Resource": "arn:aws:cognito-idp:'"$AWS_REGION"':'"$AWS_ACCOUNT_ID"':userpool/*"
          },
          {
              "Sid": "EventBridgeManagement",
              "Effect": "Allow",
              "Action": [
                  "events:PutRule",
                  "events:DeleteRule",
                  "events:DescribeRule",
                  "events:EnableRule",
                  "events:DisableRule",
                  "events:PutTargets",
                  "events:RemoveTargets",
                  "events:ListTargetsByRule",
                  "events:TagResource",
                  "events:UntagResource"
              ],
              "Resource": "arn:aws:events:'"$AWS_REGION"':'"$AWS_ACCOUNT_ID"':rule/AskUSDA-*"
          },
          {
              "Sid": "CloudWatchLogsManagement",
              "Effect": "Allow",
              "Action": [
                  "logs:CreateLogGroup",
                  "logs:DeleteLogGroup",
                  "logs:DescribeLogGroups",
                  "logs:PutRetentionPolicy",
                  "logs:DeleteRetentionPolicy",
                  "logs:TagResource",
                  "logs:UntagResource",
                  "logs:ListTagsForResource",
                  "logs:CreateLogStream",
                  "logs:PutLogEvents",
                  "logs:GetLogEvents",
                  "logs:DescribeLogStreams"
              ],
              "Resource": [
                  "arn:aws:logs:'"$AWS_REGION"':'"$AWS_ACCOUNT_ID"':log-group:/aws/lambda/AskUSDA-*",
                  "arn:aws:logs:'"$AWS_REGION"':'"$AWS_ACCOUNT_ID"':log-group:/aws/codebuild/*"
              ]
          }
      ]
    }'

    aws iam put-role-policy \
      --role-name "$ROLE_NAME" \
      --policy-name "ComputeAndDataPolicy" \
      --policy-document "$COMPUTE_POLICY"

    # --- Policy 4: AI & Search (Bedrock, S3 Vectors) ---
    AI_POLICY='{
      "Version": "2012-10-17",
      "Statement": [
          {
              "Sid": "BedrockKnowledgeBase",
              "Effect": "Allow",
              "Action": [
                  "bedrock:CreateKnowledgeBase",
                  "bedrock:DeleteKnowledgeBase",
                  "bedrock:GetKnowledgeBase",
                  "bedrock:UpdateKnowledgeBase",
                  "bedrock:CreateDataSource",
                  "bedrock:DeleteDataSource",
                  "bedrock:GetDataSource",
                  "bedrock:UpdateDataSource",
                  "bedrock:CreateGuardrail",
                  "bedrock:DeleteGuardrail",
                  "bedrock:GetGuardrail",
                  "bedrock:UpdateGuardrail",
                  "bedrock:ListGuardrails",
                  "bedrock:CreateGuardrailVersion",
                  "bedrock:TagResource",
                  "bedrock:UntagResource",
                  "bedrock:ListTagsForResource",
                  "bedrock:GetFoundationModel",
                  "bedrock:ListFoundationModels"
              ],
              "Resource": "*"
          },
          {
              "Sid": "S3Vectors",
              "Effect": "Allow",
              "Action": [
                  "s3vectors:CreateVectorBucket",
                  "s3vectors:DeleteVectorBucket",
                  "s3vectors:GetVectorBucket",
                  "s3vectors:ListVectorBuckets",
                  "s3vectors:CreateIndex",
                  "s3vectors:DeleteIndex",
                  "s3vectors:GetIndex",
                  "s3vectors:ListIndexes",
                  "s3vectors:PutVectors",
                  "s3vectors:GetVectors",
                  "s3vectors:DeleteVectors",
                  "s3vectors:QueryVectors",
                  "s3vectors:ListVectors",
                  "s3vectors:TagResource",
                  "s3vectors:UntagResource",
                  "s3vectors:ListTagsForResource"
              ],
              "Resource": "*"
          }
      ]
    }'

    aws iam put-role-policy \
      --role-name "$ROLE_NAME" \
      --policy-name "AIAndSearchPolicy" \
      --policy-document "$AI_POLICY"

    print_success "IAM role created"
    print_status "Waiting for IAM role to propagate for 10 seconds..."
    sleep 10
fi

# --- Phase 2: Create Amplify App (Static Hosting) ---
print_amplify "🌐 Phase 2: Creating Amplify Application for Static Hosting..."

# Check if app already exists
EXISTING_APP_ID=$(AWS_PAGER="" aws amplify list-apps --query "apps[?name=='$AMPLIFY_APP_NAME'].appId" --output text --region "$AWS_REGION")

if [ -n "$EXISTING_APP_ID" ] && [ "$EXISTING_APP_ID" != "None" ]; then
    print_warning "Amplify app '$AMPLIFY_APP_NAME' already exists"
    AMPLIFY_APP_ID=$EXISTING_APP_ID
else
    # Create Amplify app for static hosting
    print_status "Creating Amplify app for static hosting: $AMPLIFY_APP_NAME"

    AMPLIFY_APP_ID=$(AWS_PAGER="" aws amplify create-app \
        --name "$AMPLIFY_APP_NAME" \
        --description "AskUSDA Chatbot Application" \
        --platform WEB \
        --query 'app.appId' \
        --output text \
        --region "$AWS_REGION")

    if [ -z "$AMPLIFY_APP_ID" ] || [ "$AMPLIFY_APP_ID" = "None" ]; then
        print_error "Failed to create Amplify app"
        exit 1
    fi
    print_success "Amplify app created"
fi

# Check if main branch exists
EXISTING_BRANCH=$(AWS_PAGER="" aws amplify get-branch \
    --app-id "$AMPLIFY_APP_ID" \
    --branch-name master \
    --query 'branch.branchName' \
    --output text \
    --region "$AWS_REGION" 2>/dev/null || echo "None")

if [ "$EXISTING_BRANCH" = "master" ]; then
    print_warning "master branch already exists"
else
    # Create master branch
    print_status "Creating master branch..."

    AWS_PAGER="" aws amplify create-branch \
        --app-id "$AMPLIFY_APP_ID" \
        --branch-name master \
        --description "CodeBuild deployment branch" \
        --stage PRODUCTION \
        --no-enable-auto-build \
        --region "$AWS_REGION" || print_error "Failed to create Amplify branch."
    print_success "master branch created"
fi

# Attach Amplify deployment policy now that we have the app ID
print_status "Attaching Amplify deployment policy..."
AMPLIFY_POLICY='{
  "Version": "2012-10-17",
  "Statement": [
      {
          "Sid": "AmplifyDeployment",
          "Effect": "Allow",
          "Action": [
              "amplify:CreateDeployment",
              "amplify:StartDeployment",
              "amplify:GetApp",
              "amplify:GetBranch"
          ],
          "Resource": [
              "arn:aws:amplify:'"$AWS_REGION"':'"$AWS_ACCOUNT_ID"':apps/'"$AMPLIFY_APP_ID"'",
              "arn:aws:amplify:'"$AWS_REGION"':'"$AWS_ACCOUNT_ID"':apps/'"$AMPLIFY_APP_ID"'/*"
          ]
      }
  ]
}'

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "AmplifyDeploymentPolicy" \
  --policy-document "$AMPLIFY_POLICY"

print_success "Amplify policy attached"

# --- Phase 3: Create Unified CodeBuild Project ---
print_codebuild "🏗️ Phase 3: Creating Unified CodeBuild Project..."

# Build environment variables for unified deployment
ENV_VARS_ARRAY='{
    "name": "AMPLIFY_APP_ID",
    "value": "'"$AMPLIFY_APP_ID"'",
    "type": "PLAINTEXT"
  },{
    "name": "CDK_DEFAULT_REGION",
    "value": "'"$AWS_REGION"'",
    "type": "PLAINTEXT"
  },{
    "name": "CDK_DEFAULT_ACCOUNT",
    "value": "'"$AWS_ACCOUNT_ID"'",
    "type": "PLAINTEXT"
  }'

ENVIRONMENT=$(cat <<EOF
{
  "type": "ARM_CONTAINER",
  "image": "aws/codebuild/amazonlinux-aarch64-standard:3.0",
  "computeType": "BUILD_GENERAL1_LARGE",
  "privilegedMode": true,
  "environmentVariables": [$ENV_VARS_ARRAY]
}
EOF
)

SOURCE='{
  "type":"GITHUB",
  "location":"'$REPOSITORY_URL'",
  "buildspec":"buildspec.yml"
}'

ARTIFACTS='{"type":"NO_ARTIFACTS"}'
SOURCE_VERSION="master"

print_status "Creating unified CodeBuild project '$CODEBUILD_PROJECT_NAME'..."
AWS_PAGER="" aws codebuild create-project \
  --name "$CODEBUILD_PROJECT_NAME" \
  --source "$SOURCE" \
  --source-version "$SOURCE_VERSION" \
  --artifacts "$ARTIFACTS" \
  --environment "$ENVIRONMENT" \
  --service-role "$ROLE_ARN" \
  --output json > /dev/null || print_error "Failed to create CodeBuild project."

print_success "Unified CodeBuild project '$CODEBUILD_PROJECT_NAME' created."

# --- Phase 4: Start Unified Build ---
print_codebuild "🚀 Phase 4: Starting Unified Deployment (Backend + Frontend)..."

print_status "Starting deployment build for project '$CODEBUILD_PROJECT_NAME'..."
BUILD_ID=$(AWS_PAGER="" aws codebuild start-build \
  --project-name "$CODEBUILD_PROJECT_NAME" \
  --query 'build.id' \
  --output text)

if [ $? -ne 0 ]; then
  print_error "Failed to start the deployment build"
fi

print_success "Deployment build started successfully."

# Stream logs
print_status "Streaming deployment logs..."
echo ""

# Extract log group and stream from build ID
LOG_GROUP="/aws/codebuild/$CODEBUILD_PROJECT_NAME"
LOG_STREAM=$(echo "$BUILD_ID" | cut -d':' -f2)

# Wait a few seconds for logs to start
sleep 5

# Stream logs with filtering for CDK outputs only
BUILD_STATUS="IN_PROGRESS"
LAST_TOKEN=""
IN_CDK_OUTPUT_SECTION=false

print_status "Monitoring build progress (showing CDK outputs only)..."
echo ""

while [ "$BUILD_STATUS" = "IN_PROGRESS" ]; do
  # Get logs
  if [ -z "$LAST_TOKEN" ]; then
    LOG_OUTPUT=$(AWS_PAGER="" aws logs get-log-events \
      --log-group-name "$LOG_GROUP" \
      --log-stream-name "$LOG_STREAM" \
      --start-from-head \
      --output json 2>/dev/null)
  else
    LOG_OUTPUT=$(AWS_PAGER="" aws logs get-log-events \
      --log-group-name "$LOG_GROUP" \
      --log-stream-name "$LOG_STREAM" \
      --next-token "$LAST_TOKEN" \
      --output json 2>/dev/null)
  fi
  
  # Filter logs to show only CDK outputs and important milestones
  if [ -n "$LOG_OUTPUT" ]; then
    echo "$LOG_OUTPUT" | jq -r '.events[]?.message' 2>/dev/null | while IFS= read -r line; do
      # Skip container metadata and empty lines
      if [[ "$line" =~ ^\[Container\] ]] || [[ -z "$line" ]]; then
        continue
      fi
      
      # Show phase transitions
      if [[ "$line" =~ "BACKEND DEPLOYMENT" ]] || \
         [[ "$line" =~ "FRONTEND DEPLOYMENT" ]] || \
         [[ "$line" =~ "Deploying CDK stack" ]] || \
         [[ "$line" =~ "Building Next.js" ]] || \
         [[ "$line" =~ "Deploying frontend to Amplify" ]]; then
        echo -e "${BLUE}[PHASE]${NC} $line"
        continue
      fi
      
      # Detect CDK output section start — suppress output values (contain URLs/IDs)
      if [[ "$line" =~ "Outputs:" ]] || [[ "$line" =~ "Stack ARN:" ]]; then
        IN_CDK_OUTPUT_SECTION=true
        echo -e "${GREEN}[CDK OUTPUT]${NC} Stack outputs generated (redacted from logs)"
        continue
      fi
      
      # Skip CDK outputs entirely — they contain sensitive API URLs and resource IDs
      if [[ "$IN_CDK_OUTPUT_SECTION" == true ]]; then
        if [[ "$line" =~ "Stack ARN:" ]] || \
           [[ "$line" =~ "CDK deployment complete" ]] || \
           [[ "$line" =~ "Extracting WebSocket URL" ]]; then
          IN_CDK_OUTPUT_SECTION=false
          continue
        fi
        # Silently skip all output lines
        continue
      fi
      
      # Show errors (skip echo statements that just contain error text)
      if [[ "$line" =~ "ERROR" ]] || [[ "$line" =~ "Error" ]] || [[ "$line" =~ "Failed" ]]; then
        if [[ ! "$line" =~ ^[[:space:]]*echo[[:space:]] ]]; then
          echo -e "${RED}[ERROR]${NC} $line"
        fi
      fi
      
      # Show success messages
      if [[ "$line" =~ "successfully" ]] || [[ "$line" =~ "Complete deployment finished" ]]; then
        echo -e "${GREEN}[SUCCESS]${NC} $line"
      fi
    done
    
    LAST_TOKEN=$(echo "$LOG_OUTPUT" | jq -r '.nextForwardToken' 2>/dev/null)
  fi
  
  # Check build status
  BUILD_STATUS=$(AWS_PAGER="" aws codebuild batch-get-builds --ids "$BUILD_ID" --query 'builds[0].buildStatus' --output text)
  
  sleep 3
done

echo ""
print_status "Deployment build status: $BUILD_STATUS"

if [ "$BUILD_STATUS" != "SUCCEEDED" ]; then
  print_error "Deployment build failed with status: $BUILD_STATUS"
  print_status "Check CodeBuild logs in the AWS Console for details."
  exit 1
fi

print_success "Complete deployment finished successfully!"

# --- Final Summary ---
print_success "COMPLETE DEPLOYMENT SUCCESSFUL!"
echo ""
echo "=========================================================================="
echo "                         DEPLOYMENT SUMMARY                               "
echo "=========================================================================="
echo ""
echo "   CDK Stack: $STACK_NAME"
echo "   AWS Region: $AWS_REGION"
echo ""
echo "What was deployed:"
echo "   - CDK backend infrastructure via CodeBuild"
echo "   - WebSocket API Gateway with Lambda functions"
echo "   - Bedrock Knowledge Base with Web Crawler"
echo "   - S3 Vectors Vector Store"
echo "   - DynamoDB tables for conversations and escalations"
echo "   - Bedrock Guardrails for content filtering"
echo "   - Admin HTTP API for escalation management"
echo "   - Frontend built and deployed to Amplify via CodeBuild"
echo ""
echo "To retrieve deployment URLs, run:"
echo "   aws cloudformation describe-stacks --stack-name $STACK_NAME --query 'Stacks[0].Outputs' --output table --region $AWS_REGION"
echo ""
echo "=========================================================================="
