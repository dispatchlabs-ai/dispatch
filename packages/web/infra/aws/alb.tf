resource "aws_security_group" "alb" {
  name_prefix = "${substr(var.name, 0, 20)}-alb-"
  description = "Dispatch HTTPS ingress"
  vpc_id      = var.vpc_id
  ingress {
    description = "HTTPS from declared clients"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = sort(tolist(var.allowed_client_cidrs))
  }
  tags = local.common_tags
}
resource "aws_vpc_security_group_egress_rule" "alb_task" {
  security_group_id            = aws_security_group.alb.id
  referenced_security_group_id = aws_security_group.this.id
  from_port                    = var.container_port
  to_port                      = var.container_port
  ip_protocol                  = "tcp"
}
resource "aws_lb" "this" {
  name_prefix                = "dweb-"
  internal                   = var.alb_internal
  load_balancer_type         = "application"
  subnets                    = var.alb_subnet_ids
  security_groups            = [aws_security_group.alb.id]
  drop_invalid_header_fields = true
  tags                       = local.common_tags
}
resource "aws_lb_target_group" "this" {
  name_prefix          = "dweb-"
  port                 = var.container_port
  protocol             = "HTTP"
  target_type          = "ip"
  vpc_id               = var.vpc_id
  deregistration_delay = 30
  health_check {
    path                = "/"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
  tags = local.common_tags
  lifecycle { create_before_destroy = true }
}
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.this.arn
  }
}
