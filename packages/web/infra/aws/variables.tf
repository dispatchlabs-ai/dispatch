variable "name" {
  description = "Stable lowercase name for this independent Dispatch installation."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,37}$", var.name))
    error_message = "name must contain 3-38 lowercase letters, numbers, or hyphens and start with a letter."
  }
}

variable "vpc_id" {
  description = "Caller-owned VPC in which the Dispatch service runs."
  type        = string
}

variable "subnet_ids" {
  description = "Caller-owned private subnets used by the Fargate service."
  type        = list(string)

  validation {
    condition     = length(var.subnet_ids) >= 2
    error_message = "subnet_ids must contain at least two subnets."
  }
}

variable "cluster_arn" {
  description = "ARN of the caller-owned ECS cluster."
  type        = string
}





variable "assign_public_ip" {
  description = "Assign a public address to the task ENI. Private subnets with controlled egress are the default."
  type        = bool
  default     = false
}

variable "egress_rules" {
  description = "Explicit task egress. Override the default when adopting a private installation with narrower existing network rules."
  type = list(object({
    description     = string
    from_port       = number
    to_port         = number
    protocol        = string
    cidr_blocks     = optional(list(string), [])
    security_groups = optional(list(string), [])
  }))
  default = [{
    description = "Application, registry, logs, secrets, and S3 Files traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }]
}

variable "origin" {
  description = "Canonical private HTTPS origin used for Host, cookie, and callback checks."
  type        = string

  validation {
    condition     = can(regex("^https://[A-Za-z0-9.-]+$", var.origin))
    error_message = "origin must be an HTTPS origin without a path, query, fragment, or trailing slash."
  }
}

variable "image_uri" {
  description = "Immutable x86_64 Linux Dispatch Web image reference pinned by a full sha256 digest."
  type        = string

  validation {
    condition     = can(regex("^[^[:space:]]+@sha256:[0-9a-f]{64}$", var.image_uri))
    error_message = "image_uri must end in @sha256:<64 lowercase hexadecimal characters>."
  }
}


variable "desired_count" {
  description = "Serving owner count. Keep zero through bootstrap and every exclusive lifecycle operation; one is the only active state."
  type        = number
  default     = 0

  validation {
    condition     = contains([0, 1], var.desired_count)
    error_message = "desired_count must be 0 or 1 because the managed Dispatch root has one writer."
  }
}


variable "s3_files_file_system_id" {
  description = "ID of the caller-owned S3 Files filesystem."
  type        = string
}

variable "s3_files_file_system_arn" {
  description = "ARN of the caller-owned S3 Files filesystem."
  type        = string
}

variable "s3_files_bucket_arn" {
  description = "ARN of the caller-owned authoritative S3 bucket behind the filesystem."
  type        = string

  validation {
    condition     = can(regex("^arn:[^:]+:s3:::[a-z0-9][a-z0-9.-]+$", var.s3_files_bucket_arn))
    error_message = "s3_files_bucket_arn must be a general-purpose S3 bucket ARN."
  }
}

variable "s3_files_prefix" {
  description = "Caller-owned bucket prefix exposed as the S3 Files filesystem root; empty means the bucket root."
  type        = string

  validation {
    condition = (
      var.s3_files_prefix == "" || (
        !startswith(var.s3_files_prefix, "/") &&
        endswith(var.s3_files_prefix, "/") &&
        !strcontains(var.s3_files_prefix, "//") &&
        !strcontains(var.s3_files_prefix, "..") &&
        trimspace(var.s3_files_prefix) == var.s3_files_prefix
      )
    )
    error_message = "s3_files_prefix must be empty for a bucket-root filesystem or a relative prefix ending in /, without whitespace, //, or .. components."
  }
}

variable "container_port" {
  description = "Unencrypted HTTP port used between the caller-owned ingress and Dispatch task."
  type        = number
  default     = 3001

  validation {
    condition     = var.container_port >= 1024 && var.container_port <= 65535
    error_message = "container_port must be an unprivileged TCP port."
  }
}

variable "cpu" {
  description = "Fargate CPU units reserved for the Dispatch task."
  type        = number
  default     = 512

  validation {
    condition     = contains([256, 512, 1024, 2048, 4096], var.cpu)
    error_message = "cpu must be one of the bounded Fargate CPU sizes from 256 through 4096 units."
  }
}

variable "memory" {
  description = "Fargate memory in MiB reserved for the Dispatch task."
  type        = number
  default     = 2048

  validation {
    condition     = var.memory >= 512 && var.memory <= 30720 && floor(var.memory) == var.memory
    error_message = "memory must be an integer between 512 and 30720 MiB."
  }
}

variable "ephemeral_storage_gib" {
  description = "Ephemeral task storage, including the Fargate-provided 20 GiB baseline. Durable Dispatch state remains on /data."
  type        = number
  default     = 20

  validation {
    condition     = var.ephemeral_storage_gib >= 20 && var.ephemeral_storage_gib <= 200 && floor(var.ephemeral_storage_gib) == var.ephemeral_storage_gib
    error_message = "ephemeral_storage_gib must be an integer between 20 and 200."
  }
}

variable "stop_timeout_seconds" {
  description = "Grace period for the managed owner to stop before ECS sends SIGKILL."
  type        = number
  default     = 120

  validation {
    condition     = var.stop_timeout_seconds >= 30 && var.stop_timeout_seconds <= 120
    error_message = "stop_timeout_seconds must be between 30 and 120."
  }
}

variable "health_check_grace_period_seconds" {
  description = "Startup grace period during which the ECS scheduler ignores unhealthy container and load-balancer health checks."
  type        = number
  default     = 60

  validation {
    condition     = var.health_check_grace_period_seconds >= 0 && var.health_check_grace_period_seconds <= 900
    error_message = "health_check_grace_period_seconds must be between 0 and 900."
  }
}

variable "environment" {
  description = "Non-secret application configuration. DISPATCH runtime paths, host, port, origin, HOME and NODE_ENV are module-owned."
  type        = map(string)
  default     = {}
}

variable "secret_environment" {
  description = "Environment variable names mapped to exact Secrets Manager secret or SSM parameter ARNs. Secret values never enter OpenTofu state."
  type        = map(string)
  default     = {}

  validation {
    condition = alltrue([
      for arn in values(var.secret_environment) : (
        can(regex("^arn:[^:*?]+:secretsmanager:[a-z0-9-]+:[0-9]{12}:secret:[A-Za-z0-9/_+=.@-]+$", arn)) ||
        can(regex("^arn:[^:*?]+:ssm:[a-z0-9-]+:[0-9]{12}:parameter/[A-Za-z0-9_./-]+$", arn))
      )
    ])
    error_message = "secret_environment values must be exact Secrets Manager secret or SSM parameter ARNs."
  }
}

variable "secret_kms_key_arns" {
  description = "Exact customer-managed KMS key ARNs needed to decrypt declared secret references."
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for arn in var.secret_kms_key_arns : can(regex("^arn:[^:*?]+:kms:[a-z0-9-]+:[0-9]{12}:key/[0-9a-f-]+$", arn))
    ])
    error_message = "secret_kms_key_arns must contain exact KMS key ARNs without wildcards."
  }
}

variable "ecr_repository_arns" {
  description = "Exact private ECR repository ARNs from which the execution role may pull image_uri. Leave empty for a public registry."
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for arn in var.ecr_repository_arns : can(regex("^arn:[^:*?]+:ecr:[a-z0-9-]+:[0-9]{12}:repository/[A-Za-z0-9_./-]+$", arn))
    ])
    error_message = "ecr_repository_arns must contain exact ECR repository ARNs without wildcards."
  }
}

variable "log_retention_days" {
  description = "CloudWatch log retention for this Dispatch service."
  type        = number
  default     = 30

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be a CloudWatch Logs supported retention value."
  }
}

variable "log_kms_key_arn" {
  description = "Optional caller-owned KMS key used to encrypt this module's CloudWatch log group."
  type        = string
  default     = null
  nullable    = true
}

variable "tags" {
  description = "Additional tags for module-owned resources."
  type        = map(string)
  default     = {}
}

variable "alb_subnet_ids" {
  description = "Caller-owned subnets in at least two AZs for the ALB."
  type        = list(string)
  validation {
    condition     = length(var.alb_subnet_ids) >= 2
    error_message = "Provide at least two ALB subnets."
  }
}
variable "certificate_arn" {
  description = "Issued ACM certificate covering the origin hostname, in the deployment region."
  type        = string
}
variable "alb_internal" {
  description = "Whether the HTTPS ALB is internal."
  type        = bool
  default     = true
}
variable "allowed_client_cidrs" {
  description = "Explicit IPv4 networks permitted to access HTTPS; no implicit public access."
  type        = set(string)
  validation {
    condition     = length(var.allowed_client_cidrs) > 0 && alltrue([for cidr in var.allowed_client_cidrs : can(cidrnetmask(cidr))])
    error_message = "Supply at least one valid IPv4 client CIDR."
  }
}
