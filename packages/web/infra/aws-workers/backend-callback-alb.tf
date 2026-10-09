# Reuse the private launcher ALB, but isolate worker callbacks from control APIs.
# The caller supplies ACM certificate material; private keys never enter this module.
locals {
  backend_callback_enabled  = var.launcher_internal_alb && var.backend_callback_certificate_arn != null
  backend_callback_hostname = "callbacks.${aws_service_discovery_private_dns_namespace.this.name}"
}
resource "aws_lb_target_group" "backend_callback" {
  count                = local.backend_callback_enabled ? 1 : 0
  name                 = "${var.name}-callbacks"
  port                 = 3001
  protocol             = "HTTPS"
  target_type          = "ip"
  vpc_id               = aws_vpc.this.id
  deregistration_delay = 360
  health_check {
    path     = "/internal/ready"
    protocol = "HTTPS"
    matcher  = "200"
  }
  tags = local.tags
}
resource "aws_lb_listener" "backend_callback" {
  count             = local.backend_callback_enabled ? 1 : 0
  load_balancer_arn = aws_lb.launcher[0].arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.backend_callback_certificate_arn
  default_action {
    type = "fixed-response"
    fixed_response {
      content_type = "text/plain"
      status_code  = "404"
      message_body = "Not found"
    }
  }
}
resource "aws_lb_listener_rule" "backend_callback" {
  count        = local.backend_callback_enabled ? 1 : 0
  listener_arn = aws_lb_listener.backend_callback[0].arn
  priority     = 1
  condition {
    path_pattern { values = ["/internal/workers/*"] }
  }
  action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.backend_callback[0].arn
  }
}
resource "aws_route53_record" "backend_callback" {
  count   = local.backend_callback_enabled ? 1 : 0
  zone_id = aws_service_discovery_private_dns_namespace.this.hosted_zone
  name    = local.backend_callback_hostname
  type    = "A"
  alias {
    name                   = aws_lb.launcher[0].dns_name
    zone_id                = aws_lb.launcher[0].zone_id
    evaluate_target_health = true
  }
}
