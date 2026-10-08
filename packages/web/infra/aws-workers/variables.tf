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
  description = "Immutable workers OCI registry digest. Null prepares foundation only."
  type        = string
  default     = null
  validation {
    condition     = var.image == null ? true : can(regex("@sha256:[a-f0-9]{64}$", var.image))
    error_message = "Use an immutable registry digest."
  }
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
