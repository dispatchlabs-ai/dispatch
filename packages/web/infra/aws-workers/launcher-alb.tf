# All ordinary launcher callers use this ingress before rolling is enabled.
# Peer handover remains direct and authenticated, not load balanced.
resource "aws_lb" "launcher" {
  count                      = var.launcher_internal_alb ? 1 : 0
  name                       = "${var.name}-launcher"
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.tasks["launcher_alb"].id]
  subnets                    = aws_subnet.private[*].id
  idle_timeout               = 400
  drop_invalid_header_fields = true
  tags                       = local.tags
}
resource "aws_lb_target_group" "launcher" {
  count                = var.launcher_internal_alb ? 1 : 0
  name                 = "${var.name}-launcher"
  port                 = 8830
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = aws_vpc.this.id
  deregistration_delay = 360
  health_check {
    path     = "/internal/ready"
    protocol = "HTTP"
    matcher  = "200"
  }
  tags = local.tags
}
resource "aws_lb_listener" "launcher" {
  count             = var.launcher_internal_alb ? 1 : 0
  load_balancer_arn = aws_lb.launcher[0].arn
  port              = 8830
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.launcher[0].arn
  }
}
