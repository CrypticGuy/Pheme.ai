# Security

## Reporting a problem

Please don't open a public issue for a security problem. Report it privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it.

You'll get a reply within a few days. Fixes are released as soon as they're ready, and reporters are credited unless they prefer not to be.

## What counts

Pheme's job is to make sure a review verdict comes from the named person, not from an agent. Anything that breaks that is in scope, for example:

- an agent or review text recording a verdict without a person accepting the form,
- reading or answering reviews in someone else's inbox,
- sending reviews to someone you aren't connected with,
- getting or reusing another person's token.

The known limits in [docs/architecture.md](docs/architecture.md#trust-model) are not vulnerabilities on their own: a token holder can act as that person, and the LAN broker uses plain HTTP.

## Keeping your account safe

- Keep `~/.pheme/config.json` private. It holds your token.
- If it leaks, run `pheme rotate`. The old token stops working immediately.
- Never commit `.mcp.json` or a Supabase service-role key.
