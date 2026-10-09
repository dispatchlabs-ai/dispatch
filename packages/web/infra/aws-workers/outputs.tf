output "service_cluster_arn" { value = aws_ecs_cluster.this.arn }
output "private_subnet_ids" { value = aws_subnet.private[*].id }
output "worker_security_group_id" { value = aws_security_group.tasks["worker"].id }
output "worker_task_definition_arn" { value = try(aws_ecs_task_definition.worker[0].arn, null) }
output "ecr_repository_url" { value = aws_ecr_repository.this.repository_url }
output "database_address" { value = aws_db_instance.this.address }
output "database_master_secret_arn" {
  value       = aws_db_instance.this.master_user_secret[0].secret_arn
  description = "Operator bootstrap only; never inject master credentials into services/workers."
}
output "artifact_bucket" { value = aws_s3_bucket.artifacts.id }
output "backend_private_url" { value = "https://backend.${aws_service_discovery_private_dns_namespace.this.name}:3001" }
output "launcher_private_url" { value = var.launcher_internal_alb ? "http://${aws_lb.launcher[0].dns_name}:8830" : "http://launcher.${aws_service_discovery_private_dns_namespace.this.name}:8830" }
output "alb_dns_name" { value = try(aws_lb.this[0].dns_name, null) }
output "alb_zone_id" { value = try(aws_lb.this[0].zone_id, null) }
output "task_role_arns" { value = { for key, role in aws_iam_role.task : key => role.arn } }

output "worker_cluster_arn" { value = aws_ecs_cluster.workers.arn }
output "database_initializer" {
  value = local.database_initializer_enabled ? {
    task_definition_arn = aws_ecs_task_definition.database_initializer[0].arn
    security_group_id   = aws_security_group.database_initializer[0].id
    execution_role_arn  = aws_iam_role.database_initializer_execution[0].arn
    task_role_arn       = aws_iam_role.database_initializer_task[0].arn
  } : null
  description = "Operator-only RunTask inputs, using service_cluster_arn/private_subnet_ids and no public IP. Not scheduled by Terraform."
}
