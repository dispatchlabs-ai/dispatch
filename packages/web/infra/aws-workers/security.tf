resource "aws_security_group" "tasks" {
  for_each    = toset(concat(["backend", "launcher", "worker", "alb"], var.launcher_internal_alb ? ["launcher_alb"] : []))
  name_prefix = "${var.name}-${each.key}-"
  description = "${var.name} ${each.key} only"
  vpc_id      = aws_vpc.this.id
  tags        = local.tags
}
resource "aws_vpc_security_group_ingress_rule" "database" {
  for_each                     = toset(["backend", "launcher", "worker"])
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_security_group.tasks[each.key].id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
locals {
  private_flows = merge({
    alb_backend      = { from = "alb", to = "backend", port = 3001 }
    worker_backend   = { from = "worker", to = "backend", port = 3001 }
    launcher_backend = { from = "launcher", to = "backend", port = 3001 }
    backend_launcher = { from = "backend", to = "launcher", port = 8830 }
    backend_worker   = { from = "backend", to = "worker", port = 8831 }
    }, {
    for role, mode in var.service_deployment_mode : "${role}_peer" => {
      from = role, to = role, port = role == "backend" ? 3001 : 8830
    } if mode == "rolling"
    }, var.launcher_internal_alb ? {
    backend_launcher_alb  = { from = "backend", to = "launcher_alb", port = 8830 }
    launcher_alb_launcher = { from = "launcher_alb", to = "launcher", port = 8830 }
    } : {}, local.backend_callback_enabled ? {
    worker_callback_alb  = { from = "worker", to = "launcher_alb", port = 443 }
    callback_alb_backend = { from = "launcher_alb", to = "backend", port = 3001 }
  } : {})
}
resource "aws_vpc_security_group_ingress_rule" "private" {
  for_each                     = local.private_flows
  security_group_id            = aws_security_group.tasks[each.value.to].id
  referenced_security_group_id = aws_security_group.tasks[each.value.from].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
}
resource "aws_vpc_security_group_egress_rule" "private" {
  for_each                     = local.private_flows
  security_group_id            = aws_security_group.tasks[each.value.from].id
  referenced_security_group_id = aws_security_group.tasks[each.value.to].id
  ip_protocol                  = "tcp"
  from_port                    = each.value.port
  to_port                      = each.value.port
}
resource "aws_vpc_security_group_egress_rule" "database" {
  for_each                     = toset(["backend", "launcher", "worker"])
  security_group_id            = aws_security_group.tasks[each.key].id
  referenced_security_group_id = aws_security_group.database.id
  ip_protocol                  = "tcp"
  from_port                    = 5432
  to_port                      = 5432
}
resource "aws_vpc_security_group_egress_rule" "https" {
  for_each          = toset(["backend", "launcher", "worker"])
  security_group_id = aws_security_group.tasks[each.key].id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
resource "aws_vpc_security_group_ingress_rule" "clients" {
  for_each          = var.client_cidrs
  security_group_id = aws_security_group.tasks["alb"].id
  cidr_ipv4         = each.value
  ip_protocol       = "tcp"
  from_port         = 443
  to_port           = 443
}
locals {
  task_trust = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" }, Action = "sts:AssumeRole",
    Condition = {
      StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id },
      ArnLike      = { "aws:SourceArn" = "arn:${data.aws_partition.current.partition}:ecs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:*" }
    }
  }] })
}
resource "aws_iam_role" "execution" {
  for_each           = toset(["backend", "launcher", "worker"])
  name_prefix        = "${var.name}-${each.key}-exec-"
  assume_role_policy = local.task_trust
  tags               = local.tags
}
resource "aws_iam_role" "task" {
  for_each           = toset(["backend", "launcher", "worker"])
  name_prefix        = "${var.name}-${each.key}-"
  assume_role_policy = local.task_trust
  tags               = local.tags
}
resource "aws_iam_role_policy" "execution" {
  for_each = aws_iam_role.execution
  role     = each.value.id
  policy = jsonencode({ Version = "2012-10-17", Statement = concat([
    { Effect = "Allow", Action = ["ecr:GetAuthorizationToken"], Resource = "*" },
    { Effect = "Allow", Action = ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"], Resource = aws_ecr_repository.this.arn },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.this[each.key].arn}:*" }
    ], each.key == "worker" ? [] : (length(var.services[each.key].secrets) == 0 ? [] : [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = distinct(values(var.services[each.key].secrets)) }
    ]), each.key == "worker" || length(var.secret_kms_key_arns) == 0 ? [] : [
    { Effect = "Allow", Action = ["kms:Decrypt"], Resource = tolist(var.secret_kms_key_arns), Condition = { StringEquals = { "kms:ViaService" = "secretsmanager.${data.aws_region.current.region}.amazonaws.com" } } }
  ]) })
}
resource "aws_iam_role_policy" "backend" {
  role = aws_iam_role.task["backend"].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${aws_s3_bucket.artifacts.arn}/artifacts/*"
  }] })
}
resource "aws_iam_role_policy" "launcher" {
  count = var.image == null ? 0 : 1
  role  = aws_iam_role.task["launcher"].id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect   = "Allow", Action = ["ecs:RunTask"],
      Resource = lookup(var.service_deployment_mode, "launcher", "stop-first") == "rolling" ? "arn:${data.aws_partition.current.partition}:ecs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:task-definition/${var.name}-worker:*" : aws_ecs_task_definition.worker[0].arn,
    Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.workers.arn } } },
    { Effect   = "Allow", Action = ["ecs:DescribeTasks", "ecs:StopTask"],
      Resource = "arn:${data.aws_partition.current.partition}:ecs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:task/${aws_ecs_cluster.workers.name}/*",
    Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.workers.arn } } },
    { Effect = "Allow", Action = ["ecs:ListTasks"], Resource = "*",
    Condition = { ArnEquals = { "ecs:cluster" = aws_ecs_cluster.workers.arn } } },
    { Effect   = "Allow", Action = ["ecs:TagResource"],
      Resource = "arn:${data.aws_partition.current.partition}:ecs:${data.aws_region.current.region}:${data.aws_caller_identity.current.account_id}:task/${aws_ecs_cluster.workers.name}/*",
    Condition = { StringEquals = { "ecs:CreateAction" = "RunTask" } } },
    { Effect = "Allow", Action = ["iam:PassRole"], Resource = [aws_iam_role.execution["worker"].arn, aws_iam_role.task["worker"].arn],
    Condition = { StringEquals = { "iam:PassedToService" = "ecs-tasks.amazonaws.com" } } }
  ] })
}
