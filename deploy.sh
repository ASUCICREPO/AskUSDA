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

    print_status "Attaching custom deployment policy..."
    CUSTOM_POLICY='{
      "Version": "2012-10-17",
      "Statement": [
          {
              "Sid": "FullDeploymentAccess",
              "Effect": "Allow",
              "Action": [
                  "cloudformation:*",
                  "iam:*",
                  "lambda:*",
                  "dynamodb:*",
                  "s3:*",
                  "bedrock:*",
                  "amplify:*",
                  "codebuild:*",
                  "logs:*",
                  "apigateway:*",
                  "execute-api:*",
                  "ssm:*",
                  "events:*",
                  "aoss:*",
                  "secretsmanager:*"
              ],
              "Resource": "*"
          },
          {
              "Sid": "STSAccess",
              "Effect": "Allow",
              "Action": ["sts:GetCallerIdentity", "sts:AssumeRole"],
              "Resource": "*"
          }
      ]
    }'

    aws iam put-role-policy \
      --role-name "$ROLE_NAME" \
      --policy-name "DeploymentPolicy" \
      --policy-document "$CUSTOM_POLICY"

    print_success "IAM role created"
    print_status "Waiting for IAM role to propagate for 10 seconds..."
    sleep 10
fi

# --- Phase 2: Create Amplify App (Static Hosting) ---
print_amplify "🌐 Phase 2: Creating Amplify Application for Static Hosting..."

# Check if app already exists
EXISTING_APP_ID=$(AWS_PAGER="" aws amplify list-apps --query "apps[?name=='$AMPLIFY_APP_NAME'].appId" --output text --region "$AWS_REGION")

if [ -n "$EXISTING_APP_ID" ] && [ "$EXISTING_APP_ID" != "None" ]; then
    print_warning "Amplify app '$AMPLIFY_APP_NAME' already exists with ID: $EXISTING_APP_ID"
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
    print_success "Amplify app created with ID: $AMPLIFY_APP_ID"
fi

# Check if main branch exists
EXISTING_BRANCH=$(AWS_PAGER="" aws amplify get-branch \
    --app-id "$AMPLIFY_APP_ID" \
    --branch-name codeBuild \
    --query 'branch.branchName' \
    --output text \
    --region "$AWS_REGION" 2>/dev/null || echo "None")

if [ "$EXISTING_BRANCH" = "codeBuild" ]; then
    print_warning "codeBuild branch already exists"
else
    # Create codeBuild branch
    print_status "Creating codeBuild branch..."

    AWS_PAGER="" aws amplify create-branch \
        --app-id "$AMPLIFY_APP_ID" \
        --branch-name codeBuild \
        --description "CodeBuild deployment branch" \
        --stage PRODUCTION \
        --no-enable-auto-build \
        --region "$AWS_REGION" || print_error "Failed to create Amplify branch."
    print_success "codeBuild branch created"
fi

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
SOURCE_VERSION="codeBuild"

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

print_success "Deployment build started successfully. Build ID: $BUILD_ID"

# Stream logs
print_status "Streaming deployment logs..."
print_status "Build ID: $BUILD_ID"
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
      
      # Detect CDK output section start
      if [[ "$line" =~ "Outputs:" ]] || [[ "$line" =~ "Stack ARN:" ]]; then
        IN_CDK_OUTPUT_SECTION=true
        echo -e "${GREEN}[CDK OUTPUT]${NC} $line"
        continue
      fi
      
      # Show CDK outputs
      if [[ "$IN_CDK_OUTPUT_SECTION" == true ]]; then
        # Stop showing when we hit the next phase
        if [[ "$line" =~ "Stack ARN:" ]] || \
           [[ "$line" =~ "CDK deployment complete" ]] || \
           [[ "$line" =~ "Extracting WebSocket URL" ]]; then
          echo -e "${GREEN}[CDK OUTPUT]${NC} $line"
          IN_CDK_OUTPUT_SECTION=false
          continue
        fi
        
        # Show output lines (they typically start with "AskUSDA-Backend.")
        if [[ "$line" =~ ^AskUSDA-Backend\. ]] || [[ "$line" =~ ^[[:space:]]*AskUSDA-Backend\. ]]; then
          echo -e "${GREEN}[CDK OUTPUT]${NC} $line"
        fi
      fi
      
      # Show errors
      if [[ "$line" =~ "ERROR" ]] || [[ "$line" =~ "Error" ]] || [[ "$line" =~ "Failed" ]]; then
        echo -e "${RED}[ERROR]${NC} $line"
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
  print_status "Check CodeBuild logs for details: https://console.aws.amazon.com/codesuite/codebuild/projects/$CODEBUILD_PROJECT_NAME/build/$BUILD_ID/"
  exit 1
fi

print_success "Complete deployment finished successfully!"

# Extract WebSocket URL from CloudFormation
print_status "Extracting deployment information..."
WEBSOCKET_URL=$(AWS_PAGER="" aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey==\`WebSocketUrl\`].OutputValue" \
  --output text --region "$AWS_REGION")

ADMIN_API_URL=$(AWS_PAGER="" aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey==\`AdminApiUrl\`].OutputValue" \
  --output text --region "$AWS_REGION")

if [ -z "$WEBSOCKET_URL" ] || [ "$WEBSOCKET_URL" = "None" ]; then
  print_warning "Could not extract WebSocket URL from CDK outputs"
  WEBSOCKET_URL="Check CloudFormation console"
fi

# Get Amplify URL
AMPLIFY_URL=$(AWS_PAGER="" aws amplify get-app \
    --app-id "$AMPLIFY_APP_ID" \
    --query 'app.defaultDomain' \
    --output text \
    --region "$AWS_REGION")

if [ -z "$AMPLIFY_URL" ] || [ "$AMPLIFY_URL" = "None" ]; then
    AMPLIFY_URL="$AMPLIFY_APP_ID.amplifyapp.com"
fi

# --- Final Summary ---
print_success "COMPLETE DEPLOYMENT SUCCESSFUL!"
echo ""
echo "=========================================================================="
echo "                         DEPLOYMENT SUMMARY                               "
echo "=========================================================================="
echo ""
echo "   WebSocket URL: $WEBSOCKET_URL"
echo "   Admin API URL: $ADMIN_API_URL"
echo "   Amplify App ID: $AMPLIFY_APP_ID"
echo "   Frontend URL: https://codeBuild.$AMPLIFY_URL"
echo "   CDK Stack: $STACK_NAME"
echo "   AWS Region: $AWS_REGION"
echo ""
echo "What was deployed:"
echo "   - CDK backend infrastructure via CodeBuild"
echo "   - WebSocket API Gateway with Lambda functions"
echo "   - Bedrock Knowledge Base with Web Crawler"
echo "   - OpenSearch Serverless Vector Store"
echo "   - DynamoDB tables for conversations and escalations"
echo "   - Bedrock Guardrails for content filtering"
echo "   - Admin HTTP API for escalation management"
echo "   - Frontend built and deployed to Amplify via CodeBuild"
echo ""
echo "Frontend URL: https://codeBuild.$AMPLIFY_URL"
echo ""
echo "=========================================================================="
