# Contributing to Clearance

Thanks for helping improve Clearance. Contributions can be a bug report, a clearer example, a
documentation fix, or a code change.

## Report a bug

Search the [existing issues](https://github.com/timReynolds/clearance/issues) first. If the problem
has not been reported, open an issue with:

- What you expected and what happened instead.
- Steps to reproduce, including a minimal `OWNERS.toml` when ownership rules are involved.
- Your Clearance commit, Node.js version, and whether the problem occurs locally or on a host.
- Relevant error output or a screenshot, with credentials and private repository details removed.

For a feature suggestion, describe the review workflow you want to improve and a concrete example
of where it gets difficult. Discuss substantial changes in an issue before starting a large PR.

## Make a change

1. Fork the repository and create a branch for your change.
2. Follow the [development guide](docs/development.md) to install dependencies and run locally.
3. Keep the change focused on one problem. Include tests for behavior changes and update user docs
   when configuration or workflows change.
4. Run the [local checks](docs/development.md#verify-changes). For UI changes, also run the browser
   tests and include screenshots when they help explain the result.
5. Open a pull request describing the problem, the resulting behavior, and how you verified it.
   Link any related issue and call out checks you could not run.

For documentation-only changes, check formatting, relative links, and any examples you changed.
The development guide explains the code layout and test boundaries for implementation work.

## License

Contributions are made under the project's [MIT License](LICENSE).
