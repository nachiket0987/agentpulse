# AgentTrace on AWS ECS -- Terraform
#
# Provisions a minimal, production-grade AgentTrace deployment:
#
#   - VPC with public + private subnets across 2 AZs
#   - ECS Fargate cluster running the official AgentTrace container
#   - EFS volume for persistent SQLite storage (agenttrace.db)
#   - Security groups (ALB -> ECS, no public DB)
#   - ALB with HTTP listener on port 80
#   - CloudWatch log group with 30-day retention
#   - ECR repository to host the Docker image
#   - IAM roles for ECS task execution + task role
#
# Prereqs:
#   - An AWS account with default VPC or capacity in the target region
#   - A Docker image pushed to the created ECR repo (see README)
#   - terraform >= 1.5
#
# Usage:
#   terraform init
#   terraform plan -var="ecr_image_tag=latest"
#   terraform apply -var="ecr_image_tag=latest"

terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ---------------------------------------------------------------------------
# Data sources -- caller identity + latest Amazon Linux AMI (not used directly
# but handy for reference / bastion hosts)
# ---------------------------------------------------------------------------

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}

# ---------------------------------------------------------------------------
# VPC
# ---------------------------------------------------------------------------

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name        = "${var.project_name}-vpc"
    Project     = var.project_name
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

# Internet gateway for public subnets
resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = {
    Name    = "${var.project_name}-igw"
    Project = var.project_name
  }
}

# Public subnets (ALB lives here)
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index)
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name    = "${var.project_name}-public-${count.index + 1}"
    Project = var.project_name
    Tier    = "public"
  }
}

# Private subnets (ECS tasks live here)
resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = {
    Name    = "${var.project_name}-private-${count.index + 1}"
    Project = var.project_name
    Tier    = "private"
  }
}

# NAT gateway (egress for ECS tasks -- e.g. to pull from ECR if needed)
resource "aws_eip" "nat" {
  domain = "vpc"

  tags = {
    Name    = "${var.project_name}-nat-eip"
    Project = var.project_name
  }
}

resource "aws_nat_gateway" "this" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id

  tags = {
    Name    = "${var.project_name}-nat"
    Project = var.project_name
  }

  depends_on = [aws_internet_gateway.this]
}

# Route tables
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = {
    Name    = "${var.project_name}-public-rt"
    Project = var.project_name
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this.id
  }

  tags = {
    Name    = "${var.project_name}-private-rt"
    Project = var.project_name
  }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ---------------------------------------------------------------------------
# EFS -- persistent file system for agenttrace.db
# ---------------------------------------------------------------------------

resource "aws_efs_file_system" "agenttrace" {
  creation_token   = "${var.project_name}-efs"
  encrypted        = true
  performance_mode = "generalPurpose"
  throughput_mode  = "bursting"

  lifecycle_policy {
    transition_to_ia = "AFTER_30_DAYS"
  }

  tags = {
    Name    = "${var.project_name}-efs"
    Project = var.project_name
  }
}

# EFS mount targets in each private subnet (ECS tasks need these)
resource "aws_efs_mount_target" "agenttrace" {
  count          = 2
  file_system_id = aws_efs_file_system.agenttrace.id
  subnet_id      = aws_subnet.private[count.index].id

  security_groups = [aws_security_group.efs.id]
}

# ---------------------------------------------------------------------------
# IAM
# ---------------------------------------------------------------------------

# ECS task execution role -- lets ECS pull images, write logs, etc.
resource "aws_iam_role" "ecs_execution" {
  name = "${var.project_name}-ecs-execution"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })

  tags = { Project = var.project_name }
}

resource "aws_iam_role_policy_attachment" "ecs_execution_managed" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# ECS task role -- minimal permissions for the AgentTrace container
# (CloudWatch is in the execution role policy; task role is for app-level perms)
resource "aws_iam_role" "ecs_task" {
  name = "${var.project_name}-ecs-task"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })

  tags = { Project = var.project_name }
}

# ---------------------------------------------------------------------------
# ECR
# ---------------------------------------------------------------------------

resource "aws_ecr_repository" "agenttrace" {
  name                 = var.project_name
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }

  tags = { Project = var.project_name }
}

# Keep only the 10 most recent images to save storage costs
resource "aws_ecr_lifecycle_policy" "agenttrace" {
  repository = aws_ecr_repository.agenttrace.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep last ${var.ecr_image_retention_count} images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = var.ecr_image_retention_count
      }
      action = { type = "expire" }
    }]
  })
}

# ---------------------------------------------------------------------------
# Security groups
# ---------------------------------------------------------------------------

# ALB: accept HTTP from the internet
resource "aws_security_group" "alb" {
  name_prefix = "${var.project_name}-alb-"
  vpc_id      = aws_vpc.this.id
  description = "ALB security group -- public ingress on port 80"

  ingress {
    description = "HTTP from anywhere"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${var.project_name}-alb-sg"
    Project = var.project_name
  }

  lifecycle { create_before_destroy = true }
}

# ECS tasks: accept traffic only from the ALB on the dashboard port
resource "aws_security_group" "ecs" {
  name_prefix = "${var.project_name}-ecs-"
  vpc_id      = aws_vpc.this.id
  description = "ECS task security group -- ingress from ALB only"

  ingress {
    description     = "App port from ALB"
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${var.project_name}-ecs-sg"
    Project = var.project_name
  }

  lifecycle { create_before_destroy = true }
}

# EFS: accept NFS only from ECS tasks
resource "aws_security_group" "efs" {
  name_prefix = "${var.project_name}-efs-"
  vpc_id      = aws_vpc.this.id
  description = "EFS security group -- NFS from ECS tasks only"

  ingress {
    description     = "NFS from ECS tasks"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name    = "${var.project_name}-efs-sg"
    Project = var.project_name
  }

  lifecycle { create_before_destroy = true }
}

# ---------------------------------------------------------------------------
# CloudWatch
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "agenttrace" {
  name              = "/ecs/${var.project_name}"
  retention_in_days = var.log_retention_days

  tags = {
    Name    = "${var.project_name}-logs"
    Project = var.project_name
  }
}

# ---------------------------------------------------------------------------
# ALB
# ---------------------------------------------------------------------------

resource "aws_lb" "agenttrace" {
  name               = "${var.project_name}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id

  enable_deletion_protection = false

  tags = {
    Name    = "${var.project_name}-alb"
    Project = var.project_name
  }
}

resource "aws_lb_target_group" "agenttrace" {
  name        = "${var.project_name}-tg"
  port        = var.container_port
  protocol    = "HTTP"
  vpc_id      = aws_vpc.this.id
  target_type = "ip"

  health_check {
    enabled             = true
    path                = "/api/health"
    port                = "traffic-port"
    protocol            = "HTTP"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  tags = {
    Name    = "${var.project_name}-tg"
    Project = var.project_name
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.agenttrace.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.agenttrace.arn
  }
}

# ---------------------------------------------------------------------------
# ECS Cluster + Service
# ---------------------------------------------------------------------------

resource "aws_ecs_cluster" "agenttrace" {
  name = "${var.project_name}-cluster"

  setting {
    name  = "containerInsights"
    value = "enabled"
  }

  tags = { Project = var.project_name }
}

resource "aws_ecs_cluster_capacity_providers" "agenttrace" {
  cluster_name       = aws_ecs_cluster.agenttrace.name
  capacity_providers = ["FARGATE"]

  default_capacity_provider_strategy {
    base              = 1
    weight            = 100
    capacity_provider = "FARGATE"
  }
}

# ECS Task Definition
resource "aws_ecs_task_definition" "agenttrace" {
  family                   = var.project_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "agenttrace"
      image     = "${aws_ecr_repository.agenttrace.repository_url}:${var.ecr_image_tag}"
      essential = true

      portMappings = [
        {
          containerPort = var.container_port
          hostPort      = var.container_port
          protocol      = "tcp"
        }
      ]

      environment = [
        { name = "NODE_ENV", value = "production" },
        { name = "AGENTTRACE_DB_PATH", value = "/app/data/agenttrace.db" },
      ]

      mountPoints = [
        {
          sourceVolume  = "agenttrace-data"
          containerPath = "/app/data"
          readOnly      = false
        }
      ]

      healthCheck = {
        command     = ["CMD-SHELL", "wget --no-verbose --tries=1 --spider http://localhost:${var.container_port}/api/health || exit 1"]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 10
      }

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.agenttrace.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "ecs"
        }
      }
    }
  ])

  volume {
    name = "agenttrace-data"

    efs_volume_configuration {
      file_system_id     = aws_efs_file_system.agenttrace.id
      transit_encryption = "ENABLED"
      authorization_config {
        access_point_id = null
        iam             = "DISABLED"
      }
    }
  }

  tags = { Project = var.project_name }
}

# ECS Service
resource "aws_ecs_service" "agenttrace" {
  name            = "${var.project_name}-service"
  cluster         = aws_ecs_cluster.agenttrace.id
  task_definition = aws_ecs_task_definition.agenttrace.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.agenttrace.arn
    container_name   = "agenttrace"
    container_port   = var.container_port
  }

  # Force new deploy when the image tag changes
  force_new_deployment = true

  deployment_configuration {
    minimum_healthy_percent = 0
    maximum_percent         = 200
  }

  depends_on = [aws_lb_listener.http]

  tags = { Project = var.project_name }
}
