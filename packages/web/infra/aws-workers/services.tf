locals {
  mounted_paths = { data = "/data", tmp = "/tmp", workspace = "/workspace" }
  mounts        = [for name, path in local.mounted_paths : { sourceVolume = name, containerPath = path, readOnly = false }]
  # Fargate bind volumes begin root-owned. This secret-free init container fixes
  # only volume roots; the application is never run as root.
  volume_init = {
    name                   = "volume-init", image = var.image, essential = false, user = "0:0",
    entryPoint             = ["/bin/sh", "-c"],
    command                = ["touch /data/.dispatch-volume-init /tmp/.dispatch-volume-init /workspace/.dispatch-volume-init && chown 65532:65532 /data /tmp /workspace && chmod 0700 /data /workspace && chmod 1777 /tmp"],
    readonlyRootFilesystem = true, mountPoints = local.mounts,
    environment            = [], portMappings = [], systemControls = [], volumesFrom = []
  }
  runtime = {
    image                  = var.image, essential = true, user = "65532:65532",
    readonlyRootFilesystem = true, mountPoints = local.mounts,
    dependsOn              = [{ containerName = "volume-init", condition = "SUCCESS" }],
    linuxParameters        = { initProcessEnabled = true, capabilities = { add = [], drop = ["ALL"] } },
    portMappings           = [], systemControls = [], volumesFrom = [],
    stopTimeout            = 120
  }
}
resource "aws_ecs_task_definition" "stable" {
  for_each                 = var.image == null ? {} : var.services
  family                   = "${var.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.execution[each.key].arn
  task_role_arn            = aws_iam_role.task[each.key].arn
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
      name         = each.key, command = ["dispatch-bootstrap", each.key],
      environment  = [for name, value in each.value.environment : { name = name, value = value }],
      secrets      = [for name, arn in each.value.secrets : { name = name, valueFrom = arn }],
      portMappings = [{ containerPort = each.key == "backend" ? 3001 : 8830, hostPort = each.key == "backend" ? 3001 : 8830, protocol = "tcp" }],
      logConfiguration = { logDriver = "awslogs", options = {
        awslogs-group  = aws_cloudwatch_log_group.this[each.key].name,
        awslogs-region = data.aws_region.current.region, awslogs-stream-prefix = each.key
      } }
    })
  ])
  tags = local.tags
}
resource "aws_ecs_task_definition" "worker" {
  count                    = var.image == null ? 0 : 1
  family                   = "${var.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "2048"
  execution_role_arn       = aws_iam_role.execution["worker"].arn
  task_role_arn            = aws_iam_role.task["worker"].arn
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
      name             = "worker", command = ["dispatch-worker"],
      workingDirectory = "/workspace",
      environment      = [{ name = "DISPATCH_WORKSPACE_DIR", value = "/workspace" }],
      portMappings     = [{ containerPort = 8831, hostPort = 8831, protocol = "tcp" }],
      logConfiguration = { logDriver = "awslogs", options = {
        awslogs-group  = aws_cloudwatch_log_group.this["worker"].name,
        awslogs-region = data.aws_region.current.region, awslogs-stream-prefix = "worker"
      } }
    })
  ])
  tags = local.tags
}
resource "aws_service_discovery_private_dns_namespace" "this" {
  name = "${var.name}.internal"
  vpc  = aws_vpc.this.id
  tags = local.tags
}
resource "aws_service_discovery_service" "stable" {
  for_each = toset(["backend", "launcher"])
  name     = each.key
  dns_config {
    namespace_id   = aws_service_discovery_private_dns_namespace.this.id
    routing_policy = "MULTIVALUE"
    dns_records {
      ttl  = 10
      type = "A"
    }
  }
  health_check_custom_config { failure_threshold = 1 }
  tags = local.tags
}
resource "aws_ecs_service" "stable" {
  for_each                           = var.image == null ? {} : var.services
  name                               = each.key
  cluster                            = aws_ecs_cluster.this.id
  task_definition                    = aws_ecs_task_definition.stable[each.key].arn
  desired_count                      = var.desired_count
  launch_type                        = "FARGATE"
  platform_version                   = "1.4.0"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100
  enable_execute_command             = false
  health_check_grace_period_seconds  = each.key == "backend" && var.certificate_arn != null ? 600 : 0
  deployment_circuit_breaker {
    enable   = true
    rollback = false
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks[each.key].id]
    assign_public_ip = false
  }
  service_registries { registry_arn = aws_service_discovery_service.stable[each.key].arn }
  dynamic "load_balancer" {
    for_each = each.key == "backend" && var.certificate_arn != null ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.backend[0].arn
      container_name   = "backend"
      container_port   = 3001
    }
  }
  depends_on = [aws_lb_listener.https, aws_iam_role_policy.execution, aws_iam_role_policy.launcher, aws_iam_role_policy.backend, aws_nat_gateway.this]
  tags       = local.tags
}
resource "aws_lb" "this" {
  count                      = var.certificate_arn == null ? 0 : 1
  name                       = var.name
  internal                   = var.internal_alb
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.tasks["alb"].id]
  subnets                    = var.internal_alb ? aws_subnet.private[*].id : aws_subnet.public[*].id
  idle_timeout               = 300
  drop_invalid_header_fields = true
  tags                       = local.tags
}
resource "aws_lb_target_group" "backend" {
  count                = var.certificate_arn == null ? 0 : 1
  name                 = "${var.name}-backend"
  port                 = 3001
  protocol             = "HTTPS"
  target_type          = "ip"
  vpc_id               = aws_vpc.this.id
  deregistration_delay = 30
  health_check {
    path     = var.backend_health_check_path
    protocol = "HTTPS"
    matcher  = "200"
  }
  tags = local.tags
}
resource "aws_lb_listener" "https" {
  count             = var.certificate_arn == null ? 0 : 1
  load_balancer_arn = aws_lb.this[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend[0].arn
  }
}
resource "aws_lb_listener_rule" "deny_internal" {
  count        = var.certificate_arn == null ? 0 : 1
  listener_arn = aws_lb_listener.https[0].arn
  priority     = 1
  condition {
    path_pattern { values = ["/internal", "/internal/*"] }
  }
  action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      status_code  = "404"
      message_body = "Not found"
    }
  }
}
