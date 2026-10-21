# Dispatch AWS deployment

The supported PostgreSQL/conversation-worker AWS module now lives in
[terraform-aws-dispatch](https://github.com/dispatchlabs-ai/terraform-aws-dispatch).
Its root module, installation example, operator commands and qualification record
are maintained there. This application repository owns runtime/bootstrap code and
container artifacts; customer repositories own account configuration and state.

Use the standalone module's documented release and image pins. Repository creation
is not public artifact publication or a verified fresh AWS installation. No module
copy is maintained here.
