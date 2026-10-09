# Optional unscheduled private credential-authority terminal. Never a service.
# Independently confirm backend/previous maintenance executors STOPPED before RunTask.
variable "credential_maintenance" {
  type    = object({ environment = map(string), secrets = map(string) })
  default = null
}
locals { credential_maintenance_enabled = var.credential_maintenance != null && var.image != null }
resource "aws_ecs_cluster" "credential_maintenance" {
  count = local.credential_maintenance_enabled ? 1 : 0
  name  = "${var.name}-credential-maintenance"
  configuration {
    execute_command_configuration { logging = "NONE" }
  }
  tags = local.tags
}
resource "aws_security_group" "credential_maintenance" {
  count       = local.credential_maintenance_enabled ? 1 : 0
  name_prefix = "${var.name}-credential-"
  description = "Temporary credential CLI, no inbound or application access"
  vpc_id      = aws_vpc.this.id
  tags        = local.tags
}
resource "aws_vpc_security_group_egress_rule" "credential_maintenance_https" {
  count             = local.credential_maintenance_enabled ? 1 : 0
  security_group_id = aws_security_group.credential_maintenance[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
resource "aws_vpc_security_group_egress_rule" "credential_maintenance_sql" {
  count                        = local.credential_maintenance_enabled ? 1 : 0
  security_group_id            = aws_security_group.credential_maintenance[0].id
  referenced_security_group_id = aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
resource "aws_vpc_security_group_ingress_rule" "credential_maintenance_sql" {
  count                        = local.credential_maintenance_enabled ? 1 : 0
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.credential_maintenance[0].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
resource "aws_iam_role" "credential_maintenance_execution" {
  count              = local.credential_maintenance_enabled ? 1 : 0
  name_prefix        = "${var.name}-credential-exec-"
  assume_role_policy = local.task_trust
  tags               = local.tags
}
resource "aws_iam_role_policy" "credential_maintenance_execution" {
  count = local.credential_maintenance_enabled ? 1 : 0
  role  = aws_iam_role.credential_maintenance_execution[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
    { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"], Resource = aws_ecr_repository.this.arn },
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = distinct(values(var.credential_maintenance.secrets)) }
  ] })
}
resource "aws_iam_role" "credential_maintenance" {
  count              = local.credential_maintenance_enabled ? 1 : 0
  name_prefix        = "${var.name}-credential-"
  assume_role_policy = local.task_trust
  tags               = local.tags
}
resource "aws_iam_role_policy" "credential_maintenance_channels" {
  count = local.credential_maintenance_enabled ? 1 : 0
  role  = aws_iam_role.credential_maintenance[0].id
  # These channel APIs do not support resource-level IAM. No secret/database/API authority.
  policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Action = ["ssmmessages:CreateControlChannel", "ssmmessages:CreateDataChannel", "ssmmessages:OpenControlChannel", "ssmmessages:OpenDataChannel"], Resource = "*" }] })
}
resource "aws_ecs_task_definition" "credential_maintenance" {
  count                    = local.credential_maintenance_enabled ? 1 : 0
  family                   = "${var.name}-credential-maintenance"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.credential_maintenance_execution[0].arn
  task_role_arn            = aws_iam_role.credential_maintenance[0].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = var.cpu_architecture
  }
  dynamic "volume" {
    for_each = local.mounted_paths
    content { name = volume.key }
  }
  container_definitions = jsonencode([
    local.volume_init,
    merge(local.runtime, {
      name = "credential-maintenance", command = ["/bin/sleep", "infinity"],
      # ECS Exec's managed agent needs an ephemeral writable root; application tasks remain read-only.
      readonlyRootFilesystem = false,
      # Default container capabilities let the root Exec agent drop to service UID/GID.
      linuxParameters = { initProcessEnabled = true, capabilities = { add = [], drop = [] } },
      environment     = [for name, value in var.credential_maintenance.environment : { name = name, value = value }],
      secrets         = [for name, arn in var.credential_maintenance.secrets : { name = name, valueFrom = arn }]
      # Deliberately no container logConfiguration. OAuth output belongs only to the private TTY.
    })
  ])
  lifecycle {
    precondition {
      condition     = lookup(var.service_desired_counts, "backend", var.desired_count) == 0 && var.database_initializer == null
      error_message = "Credential maintenance requires backend desired zero and no database initializer; actual termination is a separate operator check."
    }
  }
  tags = local.tags
}
output "credential_maintenance" {
  value = local.credential_maintenance_enabled ? {
    cluster_arn         = aws_ecs_cluster.credential_maintenance[0].arn
    task_definition_arn = aws_ecs_task_definition.credential_maintenance[0].arn
    security_group_id   = aws_security_group.credential_maintenance[0].id
  } : null
}
