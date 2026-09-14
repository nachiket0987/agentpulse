# ---------------------------------------------------------------------------
# Variables -- AgentTrace on ECS
# ---------------------------------------------------------------------------

variable "aws_region" {
  description = "AWS region to deploy into"
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Prefix for every resource name (lowercase, no spaces)"
  type        = string
  default     = "agenttrace"
}

variable "environment" {
  description = "Environment tag (dev / staging / prod)"
  type        = string
  default     = "dev"
}

variable "vpc_cidr" {
  description = "CIDR block for the VPC"
  type        = string
  default     = "10.0.0.0/16"
}

variable "container_port" {
  description = "Port the AgentTrace dashboard listens on"
  type        = number
  default     = 4317
}

variable "task_cpu" {
  description = "Fargate task CPU units (256 = 0.25 vCPU, 512 = 0.5, 1024 = 1)"
  type        = number
  default     = 512
}

variable "task_memory" {
  description = "Fargate task memory in MiB (must be valid for chosen CPU)"
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "Number of ECS tasks to run"
  type        = number
  default     = 1
}

variable "ecr_image_tag" {
  description = "Docker image tag to deploy (e.g. latest, v0.1.0)."
  type        = string
  default     = "latest"
}

variable "ecr_image_retention_count" {
  description = "Number of ECR images to retain before lifecycle expiry"
  type        = number
  default     = 10
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days"
  type        = number
  default     = 30
}
