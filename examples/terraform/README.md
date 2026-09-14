# AgentTrace on AWS -- Terraform Deployment Example

Deploys AgentTrace as a fully managed ECS Fargate service with persistent
storage, a public ALB, and CloudWatch logging.

## Architecture

```
Internet
  |
  v
ALB (port 80) -- public subnets (2 AZs)
  |
  v
ECS Fargate task -- private subnets (2 AZs)
  |
  +-- EFS volume  (/app/data/agenttrace.db)
  +-- CloudWatch Logs
```

## What gets provisioned

- VPC with public + private subnets across 2 AZs
- Internet gateway + NAT gateway (egress for tasks)
- ECS Fargate cluster with Container Insights enabled
- ECS task definition + service (1 task by default)
- ECR repository with image scanning + lifecycle policy
- EFS file system for persistent SQLite storage (agenttrace.db)
- ALB with HTTP listener on port 80, health check on /api/health
- Security groups: ALB (public) -> ECS (private) -> EFS (NFS only)
- CloudWatch log group (30-day retention)
- IAM roles: ECS execution + task role

## Prerequisites

- AWS CLI configured with credentials
- Terraform >= 1.5
- Docker (to build + push the image)

## Quick start

1. Initialize Terraform:

   ```bash
   cd examples/terraform
   terraform init
   ```

2. Build and push the AgentTrace Docker image:

   ```bash
   # From the repo root
   aws ecr get-login-password --region us-east-1 | \
     docker login --username AWS --password-stdin \
     $(terraform output -raw ecr_repository_url)

   docker build -t agenttrace .
   docker tag agenttrace:latest $(terraform output -raw ecr_repository_url):latest
   docker push $(terraform output -raw ecr_repository_url):latest
   ```

   Or, if you want to push first and then apply:

   ```bash
   # After terraform apply gives you the ECR URL
   ECR_URL=$(terraform output -raw ecr_repository_url)
   aws ecr get-login-password --region us-east-1 | \
     docker login --username AWS --password-stdin $ECR_URL
   docker build -t agenttrace ../../
   docker tag agenttrace:latest $ECR_URL:latest
   docker push $ECR_URL:latest
   ```

3. Plan and apply:

   ```bash
   terraform plan -var="ecr_image_tag=latest"
   terraform apply -var="ecr_image_tag=latest"
   ```

4. Access the dashboard:

   ```bash
   terraform output alb_url
   # Open the URL in your browser
   ```

## Configuration

Override any variable via `-var` or a `terraform.tfvars` file:

| Variable                    | Default       | Description                  |
| --------------------------- | ------------- | ---------------------------- |
| `aws_region`                | `us-east-1`   | AWS region                   |
| `project_name`              | `agenttrace`  | Resource name prefix         |
| `environment`               | `dev`         | Environment tag              |
| `vpc_cidr`                  | `10.0.0.0/16` | VPC CIDR block               |
| `container_port`            | `4317`        | AgentTrace dashboard port    |
| `task_cpu`                  | `512`         | Fargate CPU units (0.5 vCPU) |
| `task_memory`               | `1024`        | Fargate memory (GiB)         |
| `desired_count`             | `1`           | Number of ECS tasks          |
| `ecr_image_tag`             | `latest`      | Docker image tag to deploy   |
| `ecr_image_retention_count` | `10`          | ECR images to retain         |
| `log_retention_days`        | `30`          | CloudWatch log retention     |

Example `terraform.tfvars`:

```hcl
aws_region    = "eu-west-1"
project_name  = "agenttrace-prod"
environment   = "prod"
task_cpu      = 1024
task_memory   = 2048
desired_count = 2
```

## Persistent storage

AgentTrace uses SQLite at `/app/data/agenttrace.db`. This directory is backed
by an EFS mount so data survives task restarts and deployments. The EFS volume
is encrypted at rest and transitions files to Infrequent Access after 30 days.

## Health checks

The ALB health check hits `GET /api/health` every 30s. The container also has
its own Docker-level health check (matching the Dockerfile HEALTHCHECK
instruction). Unhealthy tasks are automatically replaced.

## Cleanup

```bash
terraform destroy
```

Note: ECR images and the EFS file system may need manual deletion if
`force_delete` doesn't fully clean up. Check the AWS console after destroy.

## Notes

- This example uses HTTP (port 80) on the ALB. For production, add an ACM
  certificate and an HTTPS listener.
- Fargate tasks run in private subnets with no public IP. The NAT gateway
  provides egress for image pulls and updates.
- No RDS/PostgreSQL -- AgentTrace is designed for local SQLite. EFS gives
  durability without the cost of a managed database.
