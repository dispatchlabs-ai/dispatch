locals {
  module_version = "0.1.2"
  container_name = "dispatch-web"
  data_root      = "/dispatch/${var.name}/data"
  data_prefix    = "${var.s3_files_prefix}${trimprefix(local.data_root, "/")}/"
  reserved_environment = {
    HOME                   = "/data/home"
    NODE_ENV               = "production"
    DISPATCH_HOST          = "0.0.0.0"
    DISPATCH_PORT          = tostring(var.container_port)
    DISPATCH_ORIGIN        = var.origin
    DISPATCH_DATA_DIR      = "/data/state"
    DISPATCH_WORKSPACE_DIR = "/data/workspace"
    DISPATCH_SERVE_CLIENT  = "true"
  }
  secretsmanager_secret_arns = sort(distinct([
    for arn in values(var.secret_environment) : arn if strcontains(arn, ":secretsmanager:")
  ]))
  ssm_parameter_arns = sort(distinct([
    for arn in values(var.secret_environment) : arn if strcontains(arn, ":ssm:")
  ]))
  fargate_cpu_memory_valid = (
    (var.cpu == 256 && contains([512, 1024, 2048], var.memory)) ||
    (var.cpu == 512 && contains([1024, 2048, 3072, 4096], var.memory)) ||
    (var.cpu == 1024 && var.memory >= 2048 && var.memory <= 8192 && var.memory % 1024 == 0) ||
    (var.cpu == 2048 && var.memory >= 4096 && var.memory <= 16384 && var.memory % 1024 == 0) ||
    (var.cpu == 4096 && var.memory >= 8192 && var.memory <= 30720 && var.memory % 1024 == 0)
  )
  common_tags = merge(var.tags, {
    Name                          = var.name
    "dispatch-web/component"      = "service"
    "dispatch-web/data-owner"     = "single-writer"
    "dispatch-web/module-version" = local.module_version
  })
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/dispatch-web/${var.name}/service"
  retention_in_days = var.log_retention_days
  kms_key_id        = var.log_kms_key_arn

  tags = local.common_tags
}

resource "aws_security_group" "this" {
  name_prefix = "${var.name}-dispatch-"
  description = "Agent Dispatch HTTP ingress and caller-configurable task egress."
  vpc_id      = var.vpc_id

  ingress {
    description     = "HTTP from module HTTPS ingress"
    from_port       = var.container_port
    to_port         = var.container_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  dynamic "egress" {
    for_each = var.egress_rules
    content {
      description     = egress.value.description
      from_port       = egress.value.from_port
      to_port         = egress.value.to_port
      protocol        = egress.value.protocol
      cidr_blocks     = egress.value.cidr_blocks
      security_groups = egress.value.security_groups
    }
  }

  tags = merge(local.common_tags, {
    Name = "${var.name}-dispatch-task"
  })

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_s3files_access_point" "data" {
  file_system_id = var.s3_files_file_system_id

  posix_user {
    uid = 65532
    gid = 65532
  }

  root_directory {
    path = local.data_root

    creation_permissions {
      owner_uid   = 65532
      owner_gid   = 65532
      permissions = "0700"
    }
  }

  tags = merge(local.common_tags, {
    Name = "${var.name}-dispatch-data"
  })
}

data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task" {
  name_prefix        = "${substr(var.name, 0, 23)}-dispatch-task-"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "task" {
  statement {
    sid    = "MountDispatchDataAccessPoint"
    effect = "Allow"
    actions = [
      "s3files:ClientMount",
      "s3files:ClientWrite",
    ]
    resources = [var.s3_files_file_system_arn]

    condition {
      test     = "StringEquals"
      variable = "s3files:AccessPointArn"
      values   = [aws_s3files_access_point.data.arn]
    }
  }

  statement {
    sid    = "ReadDispatchDataObjects"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:GetObjectVersion",
    ]
    resources = ["${var.s3_files_bucket_arn}/${local.data_prefix}*"]
  }

  statement {
    sid       = "ListDispatchDataObjects"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [var.s3_files_bucket_arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values = [
        trimsuffix(local.data_prefix, "/"),
        "${local.data_prefix}*",
      ]
    }
  }
}

resource "aws_iam_role_policy" "task" {
  name   = "dispatch-data-access"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.task.json
}

resource "aws_iam_role" "execution" {
  name_prefix        = "${substr(var.name, 0, 23)}-dispatch-exec-"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
  tags               = local.common_tags
}

data "aws_iam_policy_document" "execution" {
  statement {
    sid    = "WriteServiceLogs"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }

  dynamic "statement" {
    for_each = length(var.ecr_repository_arns) > 0 ? [true] : []

    content {
      sid       = "AuthenticateToEcr"
      effect    = "Allow"
      actions   = ["ecr:GetAuthorizationToken"]
      resources = ["*"]
    }
  }

  dynamic "statement" {
    for_each = length(var.ecr_repository_arns) > 0 ? [true] : []

    content {
      sid    = "PullDeclaredImageRepositories"
      effect = "Allow"
      actions = [
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer",
      ]
      resources = sort(tolist(var.ecr_repository_arns))
    }
  }

  dynamic "statement" {
    for_each = length(local.secretsmanager_secret_arns) > 0 ? [true] : []

    content {
      sid       = "ReadDeclaredSecrets"
      effect    = "Allow"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = local.secretsmanager_secret_arns
    }
  }

  dynamic "statement" {
    for_each = length(local.ssm_parameter_arns) > 0 ? [true] : []

    content {
      sid       = "ReadDeclaredParameters"
      effect    = "Allow"
      actions   = ["ssm:GetParameters"]
      resources = local.ssm_parameter_arns
    }
  }

  dynamic "statement" {
    for_each = length(var.secret_kms_key_arns) > 0 ? [true] : []

    content {
      sid       = "DecryptDeclaredSecretKeys"
      effect    = "Allow"
      actions   = ["kms:Decrypt"]
      resources = sort(tolist(var.secret_kms_key_arns))
    }
  }
}

resource "aws_iam_role_policy" "execution" {
  name   = "dispatch-task-execution"
  role   = aws_iam_role.execution.id
  policy = data.aws_iam_policy_document.execution.json
}

locals {
  container_definition = {
    name                   = local.container_name
    image                  = var.image_uri
    essential              = true
    user                   = "65532:65532"
    readonlyRootFilesystem = true
    workingDirectory       = "/data"
    portMappings = [{
      name          = "http"
      containerPort = var.container_port
      hostPort      = var.container_port
      protocol      = "tcp"
      appProtocol   = "http"
    }]
    linuxParameters = {
      initProcessEnabled = true
      capabilities = {
        add  = []
        drop = ["ALL"]
      }
    }
    mountPoints = [
      {
        sourceVolume  = "data"
        containerPath = "/data"
        readOnly      = false
      },
      {
        sourceVolume  = "tmp"
        containerPath = "/tmp"
        readOnly      = false
      },
    ]
    environment = [
      for name, value in merge(var.environment, local.reserved_environment) : {
        name  = name
        value = value
      }
    ]
    secrets = [
      for name in sort(keys(var.secret_environment)) : {
        name      = name
        valueFrom = var.secret_environment[name]
      }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.this.name
        awslogs-region        = aws_cloudwatch_log_group.this.region
        awslogs-stream-prefix = "service"
      }
    }
    stopTimeout = var.stop_timeout_seconds
  }
}

resource "aws_ecs_task_definition" "this" {
  family                   = "${var.name}-dispatch"
  task_role_arn            = aws_iam_role.task.arn
  execution_role_arn       = aws_iam_role.execution.arn
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = tostring(var.cpu)
  memory                   = tostring(var.memory)
  container_definitions    = jsonencode([local.container_definition])
  skip_destroy             = true

  runtime_platform {
    cpu_architecture        = var.cpu_architecture
    operating_system_family = "LINUX"
  }

  dynamic "ephemeral_storage" {
    for_each = var.ephemeral_storage_gib > 20 ? [var.ephemeral_storage_gib] : []

    content {
      size_in_gib = ephemeral_storage.value
    }
  }

  volume {
    name = "data"

    s3files_volume_configuration {
      file_system_arn  = var.s3_files_file_system_arn
      access_point_arn = aws_s3files_access_point.data.arn
      root_directory   = "/"
    }
  }

  volume {
    name = "tmp"
  }

  tags = local.common_tags

  lifecycle {
    precondition {
      condition     = local.fargate_cpu_memory_valid
      error_message = "The selected cpu and memory values are not a valid bounded AWS Fargate combination."
    }

    precondition {
      condition     = length(setintersection(toset(keys(var.environment)), toset(keys(local.reserved_environment)))) == 0
      error_message = "environment must not override module-owned runtime paths, host, port, origin, HOME, or NODE_ENV."
    }

    precondition {
      condition     = length(setintersection(toset(keys(var.environment)), toset(keys(var.secret_environment)))) == 0
      error_message = "A configuration name cannot appear in both environment and secret_environment."
    }

    precondition {
      condition     = length(setintersection(toset(keys(local.reserved_environment)), toset(keys(var.secret_environment)))) == 0
      error_message = "secret_environment must not replace module-owned runtime settings."
    }
  }
}

resource "aws_ecs_service" "this" {
  name            = "${var.name}-dispatch"
  cluster         = var.cluster_arn
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  health_check_grace_period_seconds  = var.health_check_grace_period_seconds
  enable_execute_command             = false
  enable_ecs_managed_tags            = true
  propagate_tags                     = "SERVICE"

  deployment_circuit_breaker {
    enable   = true
    rollback = false
  }

  deployment_controller {
    type = "ECS"
  }

  network_configuration {
    subnets          = var.subnet_ids
    security_groups  = [aws_security_group.this.id]
    assign_public_ip = var.assign_public_ip
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.this.arn
    container_name   = local.container_name
    container_port   = var.container_port
  }

  tags = local.common_tags

  depends_on = [aws_iam_role_policy.execution, aws_iam_role_policy.task, aws_lb_listener.https]
}
