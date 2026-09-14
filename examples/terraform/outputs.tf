# ---------------------------------------------------------------------------
# Outputs -- AgentTrace on ECS
#
# Run `terraform apply` then `terraform output` to see these values.
# ---------------------------------------------------------------------------

output "ecr_repository_url" {
  description = "ECR repository URL -- push your Docker image here"
  value       = aws_ecr_repository.agenttrace.repository_url
}

output "alb_dns_name" {
  description = "DNS name of the ALB -- access AgentTrace at http://<this>"
  value       = aws_lb.agenttrace.dns_name
}

output "alb_url" {
  description = "Full HTTP URL for the AgentTrace dashboard"
  value       = "http://${aws_lb.agenttrace.dns_name}"
}

output "cloudwatch_log_group" {
  description = "CloudWatch log group for ECS task logs"
  value       = aws_cloudwatch_log_group.agenttrace.name
}

output "ecs_cluster_name" {
  description = "ECS cluster name"
  value       = aws_ecs_cluster.agenttrace.name
}

output "ecs_service_name" {
  description = "ECS service name"
  value       = aws_ecs_service.agenttrace.name
}

output "efs_file_system_id" {
  description = "EFS file system ID hosting agenttrace.db"
  value       = aws_efs_file_system.agenttrace.id
}

output "vpc_id" {
  description = "VPC ID"
  value       = aws_vpc.this.id
}
