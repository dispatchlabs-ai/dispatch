# This registers an operator task; no service, RunTask or local-exec is created.
# The operator independently verifies stopped controllers before invoking it.
locals {
  database_initializer_enabled = var.database_initializer != null && var.image != null
}
resource "aws_security_group" "database_initializer" {
  count       = local.database_initializer_enabled ? 1 : 0
  name_prefix = "${var.name}-db-init-"
  description = "Operator-only database initialization, no application ingress"
  vpc_id      = aws_vpc.this.id
  tags        = local.tags
}
resource "aws_vpc_security_group_ingress_rule" "database_initializer" {
  count                        = local.database_initializer_enabled ? 1 : 0
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.database_initializer[0].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
resource "aws_vpc_security_group_egress_rule" "database_initializer_sql" {
  count                        = local.database_initializer_enabled ? 1 : 0
  security_group_id            = aws_security_group.database_initializer[0].id
  referenced_security_group_id = aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
resource "aws_vpc_security_group_egress_rule" "database_initializer_https" {
  count             = local.database_initializer_enabled ? 1 : 0
  security_group_id = aws_security_group.database_initializer[0].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
resource "aws_iam_role" "database_initializer_execution" {
  count              = local.database_initializer_enabled ? 1 : 0
  name_prefix        = "${var.name}-db-init-exec-"
  assume_role_policy = local.task_trust
  tags               = local.tags
}
resource "aws_iam_role" "database_initializer_task" {
  count              = local.database_initializer_enabled ? 1 : 0
  name_prefix        = "${var.name}-db-init-"
  assume_role_policy = local.task_trust
  tags               = local.tags
}
resource "aws_iam_role_policy" "database_initializer_execution" {
  count = local.database_initializer_enabled ? 1 : 0
  role  = aws_iam_role.database_initializer_execution[0].id
  policy = jsonencode({ Version = "2012-10-17", Statement = concat([
    { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
    { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"], Resource = aws_ecr_repository.this.arn },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.this["bootstrap"].arn}:*" }
    ], length(var.database_initializer.secrets) == 0 ? [] : [
    { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = distinct(values(var.database_initializer.secrets)) }
    ], length(var.secret_kms_key_arns) == 0 ? [] : [
    { Effect = "Allow", Action = ["kms:Decrypt"], Resource = tolist(var.secret_kms_key_arns), Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${data.aws_region.current.region}.amazonaws.com" } } }
  ]) })
}
resource "aws_ecs_task_definition" "database_initializer" {
  count                    = local.database_initializer_enabled ? 1 : 0
  family                   = "${var.name}-db-init"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.database_initializer_execution[0].arn
  task_role_arn            = aws_iam_role.database_initializer_task[0].arn
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
      name        = "database-init", command = var.database_initializer.command,
      environment = [for name, value in var.database_initializer.environment : { name = name, value = value }],
      secrets     = [for name, arn in var.database_initializer.secrets : { name = name, valueFrom = arn }],
      logConfiguration = { logDriver = "awslogs", options = {
        awslogs-group  = aws_cloudwatch_log_group.this["bootstrap"].name,
        awslogs-region = data.aws_region.current.region, awslogs-stream-prefix = "database-init"
      } }
    })
  ])
  lifecycle {
    precondition {
      condition     = var.desired_count == 0 && alltrue([for count in values(var.service_desired_counts) : count == 0])
      error_message = "Prepare the initializer only with stable services at zero; separately confirm actual task termination before invoking it."
    }
  }
  tags = local.tags
}
