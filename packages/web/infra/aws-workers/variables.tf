variable "name" {
  type = string
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,19}$", var.name))
    error_message = "Use a 3–20 character lowercase installation name."
  }
}
variable "availability_zones" {
  type = list(string)
  validation {
    condition     = length(distinct(var.availability_zones)) == 2
    error_message = "Supply exactly two distinct availability zones."
  }
}
variable "vpc_cidr" {
  type = string
}
variable "tags" {
  type    = map(string)
  default = {}
}
variable "database_instance_class" {
  type    = string
  default = "db.t4g.small"
}
variable "database_engine_version" {
  type    = string
  default = "17"
  validation {
    condition     = can(regex("^17(\\.[0-9]+)?$", var.database_engine_version))
    error_message = "This module uses the PostgreSQL 17 parameter family."
  }
}
variable "database_storage_gib" {
  type    = number
  default = 20
}
variable "log_retention_days" {
  type    = number
  default = 30
}
variable "image" {
  description = "Immutable controller OCI registry digest (and worker fallback). Null prepares foundation only."
  type        = string
  default     = null
  validation {
    condition     = var.image == null ? true : can(regex("@sha256:[a-f0-9]{64}$", var.image))
    error_message = "Use an immutable registry digest."
  }
}
variable "worker_image" {
  description = "Optional separate immutable worker image; null retains the controller image."
  type        = string
  default     = null
  validation {
    condition     = var.worker_image == null ? true : can(regex("@sha256:[a-f0-9]{64}$", var.worker_image))
    error_message = "Use an immutable worker registry digest."
  }
}
variable "worker_package_installation" {
  description = "Opt in to trusted root workers with writable disposable root and ordinary container capabilities. Controllers remain hardened."
  type        = bool
  default     = false
}
variable "cpu_architecture" {
  type    = string
  default = "ARM64"
  validation {
    condition     = contains(["ARM64", "X86_64"], var.cpu_architecture)
    error_message = "Select ARM64 or X86_64."
  }
}
variable "services" {
  description = "Nonsecret runtime environment and exact Secrets Manager ARN references; secret values never enter Terraform."
  type = map(object({
    environment = map(string)
    secrets     = map(string)
  }))
  default = {
    backend  = { environment = {}, secrets = {} }
    launcher = { environment = {}, secrets = {} }
  }
  validation {
    condition     = toset(keys(var.services)) == toset(["backend", "launcher"])
    error_message = "Supply only backend and launcher configurations."
  }
  validation {
    condition     = alltrue([for service in values(var.services) : length(setintersection(toset(keys(service.environment)), toset(keys(service.secrets)))) == 0])
    error_message = "Environment and secret names must not overlap."
  }
}
variable "secret_kms_key_arns" {
  type    = set(string)
  default = []
}
variable "desired_count" {
  description = "Explicit activation after bootstrap and owner checks; never more than one backend/launcher."
  type        = number
  default     = 0
  validation {
    condition     = contains([0, 1], var.desired_count)
    error_message = "Only zero or one stable service owner is supported."
  }
}
variable "certificate_arn" {
  type    = string
  default = null
}
variable "internal_alb" {
  type    = bool
  default = true
}
variable "client_cidrs" {
  type    = set(string)
  default = []
}
variable "database_initializer" {
  description = "Optional operator-only one-off task definition. Never scheduled; resolved master/provisioning credentials stay out of Terraform. Remove after bootstrap."
  type = object({
    command     = list(string)
    environment = map(string)
    secrets     = map(string)
  })
  default = null
  validation {
    condition     = var.database_initializer == null ? true : length(var.database_initializer.command) > 0 && length(setintersection(toset(keys(var.database_initializer.environment)), toset(keys(var.database_initializer.secrets)))) == 0
    error_message = "Provide an explicit operator command and distinct environment/secret variable names."
  }
}

variable "backend_health_check_path" {
  description = "ALB process-liveness path. Use /internal/health with a supporting image; it must remain healthy during intentional drain. Public /internal access stays blocked."
  type        = string
  default     = "/"
  validation {
    condition     = startswith(var.backend_health_check_path, "/")
    error_message = "Health check path must start with /."
  }
}

variable "service_desired_counts" {
  description = "Optional per-controller zero/one overrides for ordered maintenance: stop backend and confirm termination before stopping launcher."
  type        = map(number)
  default     = {}
  validation {
    condition     = alltrue([for role, count in var.service_desired_counts : contains(["backend", "launcher"], role) && contains([0, 1], count)])
    error_message = "Only backend/launcher zero-or-one overrides are supported."
  }
}

variable "service_deployment_mode" {
  description = "Per-controller ECS deployment mode. Omitted services use stop-first (0/100). Rolling (100/200) enables readiness gates and same-role peer traffic; it requires a handover-capable controller image/configuration. Legacy exclusive-owner images do not support it."
  type        = map(string)
  default     = {}
  validation {
    condition     = alltrue([for role, mode in var.service_deployment_mode : contains(["backend", "launcher"], role) && contains(["stop-first", "rolling"], mode)])
    error_message = "Select stop-first or rolling for backend and/or launcher only."
  }
}
