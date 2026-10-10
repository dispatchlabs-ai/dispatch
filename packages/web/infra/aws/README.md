# Retired SQLite AWS deployment

The SQLite/S3 Files AWS topology is no longer a supported Dispatch deployment
path. Use the standalone PostgreSQL/conversation-worker module at
[terraform-aws-dispatch](https://github.com/dispatchlabs-ai/terraform-aws-dispatch).

No state migration or compatibility adapter is provided. Native local deployment
remains application-owned and is not affected by this infrastructure extraction.
