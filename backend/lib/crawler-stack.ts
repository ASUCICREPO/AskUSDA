import * as path from "path";
import {
  Stack,
  StackProps,
  Duration,
  RemovalPolicy,
  CfnOutput,
} from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ecr_assets from "aws-cdk-lib/aws-ecr-assets";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export interface CrawlerStackProps extends StackProps {
  /**
   * REQUIRED: The S3 bucket name where crawler stores data.
   * This MUST be the same bucket used as the Bedrock Knowledge Base data source.
   * 
   * The crawler writes to: s3://{bucket}/jobs/{job_id}/
   * The KB sync Lambda copies to: s3://{bucket}/ingestion-v1/
   */
  crawlerBucketName: string;
}

export class CrawlerStack extends Stack {
  public readonly dataBucket: s3.IBucket;
  public readonly cluster: ecs.ICluster;
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly containerName: string;
  public readonly securityGroup: ec2.SecurityGroup;
  public readonly vpc: ec2.Vpc;

  constructor(scope: Construct, id: string, props: CrawlerStackProps) {
    super(scope, id, props);

    // ==========================================
    // S3 Bucket for Crawled Data
    // IMPORTANT: This must match the Bedrock KB data source bucket
    // ==========================================

    this.dataBucket = s3.Bucket.fromBucketName(
      this, 
      "CrawlerDataBucket", 
      props.crawlerBucketName
    );

    // ==========================================
    // VPC for ECS Tasks
    // ==========================================

    this.vpc = new ec2.Vpc(this, "CrawlerVPC", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // ==========================================
    // ECS Cluster
    // ==========================================

    this.cluster = new ecs.Cluster(this, "CrawlerCluster", {
      vpc: this.vpc,
      clusterName: "askusda-crawler-cluster",
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });

    // ==========================================
    // CloudWatch Log Group
    // ==========================================

    const logGroup = new logs.LogGroup(this, "CrawlerLogGroup", {
      logGroupName: "/ecs/askusda-crawler",
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // ==========================================
    // IAM Role for ECS Task
    // ==========================================

    const taskRole = new iam.Role(this, "CrawlerTaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Role for AskUSDA web crawler ECS task - S3 read/write on jobs prefix",
    });

    this.dataBucket.grantReadWrite(taskRole, "jobs/*");

    // ==========================================
    // ECS Task Execution Role
    // ==========================================

    const executionRole = new iam.Role(this, "CrawlerExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonECSTaskExecutionRolePolicy"
        ),
      ],
    });

    // ==========================================
    // Docker Image from Local Dockerfile
    // ==========================================

    const crawlerDir = path.resolve(__dirname, "..", "crawler");

    const dockerImage = new ecr_assets.DockerImageAsset(
      this,
      "CrawlerImage",
      {
        directory: crawlerDir,
        file: "Dockerfile",
        exclude: [
          "cdk_deployment",
          "test_configs",
          "output",
          "venv",
          "venv311",
          ".venv",
          ".git",
          "__pycache__",
          "*.md",
          ".DS_Store",
          "*.pyc",
        ],
      }
    );

    // ==========================================
    // ECS Task Definition — 2 vCPU / 4 GB (one URL per task)
    // ==========================================

    this.taskDefinition = new ecs.FargateTaskDefinition(
      this,
      "CrawlerTaskDef",
      {
        memoryLimitMiB: 4096,
        cpu: 2048,
        taskRole,
        executionRole,
      }
    );

    const container = this.taskDefinition.addContainer("CrawlerContainer", {
      image: ecs.ContainerImage.fromDockerImageAsset(dockerImage),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "crawler",
        logGroup,
      }),
      environment: {
        USE_S3: "true",
        S3_BUCKET: this.dataBucket.bucketName,
        AWS_DEFAULT_REGION: this.region,
        SCOPE_TYPE: "all",
        MAX_DEPTH: "2",
        MAX_PAGES: "99999",
        MAX_CONCURRENT: "20",
      },
      stopTimeout: Duration.seconds(120),
    });

    this.containerName = container.containerName;

    // ==========================================
    // Security Group
    // ==========================================

    this.securityGroup = new ec2.SecurityGroup(this, "CrawlerSG", {
      vpc: this.vpc,
      allowAllOutbound: true,
    });

    // ==========================================
    // Outputs
    // ==========================================

    new CfnOutput(this, "BucketName", {
      value: this.dataBucket.bucketName,
      description: "S3 bucket for crawled data",
      exportName: "AskUSDA-CrawlerBucketName",
    });

    new CfnOutput(this, "ClusterArn", {
      value: this.cluster.clusterArn,
      description: "ECS cluster ARN",
      exportName: "AskUSDA-CrawlerClusterArn",
    });

    new CfnOutput(this, "TaskDefinitionArn", {
      value: this.taskDefinition.taskDefinitionArn,
      description: "ECS task definition ARN",
      exportName: "AskUSDA-CrawlerTaskDefArn",
    });

    new CfnOutput(this, "TaskRoleArn", {
      value: taskRole.roleArn,
      description: "Task role ARN (for iam:PassRole)",
      exportName: "AskUSDA-CrawlerTaskRoleArn",
    });

    new CfnOutput(this, "ContainerName", {
      value: container.containerName,
      description: "Container name for env overrides",
      exportName: "AskUSDA-CrawlerContainerName",
    });

    new CfnOutput(this, "LogGroupName", {
      value: logGroup.logGroupName,
      description: "CloudWatch log group",
      exportName: "AskUSDA-CrawlerLogGroupName",
    });

    const subnetIds = this.vpc.publicSubnets
      .map((s) => s.subnetId)
      .join(",");

    new CfnOutput(this, "SubnetIds", {
      value: subnetIds,
      description: "Public subnet IDs for Fargate tasks",
      exportName: "AskUSDA-CrawlerSubnetIds",
    });

    new CfnOutput(this, "SecurityGroupId", {
      value: this.securityGroup.securityGroupId,
      description: "Security group ID for Fargate tasks",
      exportName: "AskUSDA-CrawlerSecurityGroupId",
    });
  }
}
