use std::env;
use std::path::PathBuf;

use zed_extension_api::{
    self as zed, Command, ContextServerId, EnvVars, LanguageServerId,
    LanguageServerInstallationStatus, Project, Result, Worktree, serde_json::Value,
    settings::LspSettings,
};

const SERVER_ID: &str = "typegpu-inspector";
const PACKAGE_VERSION: &str = env!("CARGO_PKG_VERSION");

const LANGUAGE_SERVER_PACKAGE: &str = "typegpu-inspector-language-server";
const LANGUAGE_SERVER_ENTRY: &str =
    "node_modules/typegpu-inspector-language-server/dist/server.cjs";
const DEV_LANGUAGE_SERVER_ENTRY: &str = "server/dist/server.cjs";

const INSPECTOR_PACKAGE: &str = "typegpu-runtime-inspector-mcp";
const INSPECTOR_ENTRY: &str =
    "node_modules/typegpu-runtime-inspector-mcp/bin/typegpu-runtime-inspector-mcp.mjs";
const DEV_INSPECTOR_ENTRY: &str = "inspector/bin/typegpu-runtime-inspector-mcp.mjs";

struct TypeGpuInspectorExtension;

/// Reports npm acquisition progress back to Zed's UI. Only the language server
/// has a slot in that UI, so the context server path passes `None` and stays
/// silent rather than borrowing an unrelated server's status line.
fn report(status_id: Option<&LanguageServerId>, status: LanguageServerInstallationStatus) {
    if let Some(id) = status_id {
        zed::set_language_server_installation_status(id, &status);
    }
}

/// Resolves a server entry script: the local monorepo build when running as a
/// dev extension, otherwise an npm-acquired copy inside the extension work
/// directory (Zed registry builds must not ship the servers themselves).
fn resolve_entry(
    status_id: Option<&LanguageServerId>,
    dev_entry: &str,
    package: &str,
    installed_entry: &str,
) -> Result<PathBuf> {
    let work_dir = env::current_dir()
        .map_err(|error| format!("could not read extension work directory: {error}"))?;

    // Dev builds compile on the developer's machine, so the manifest dir is the
    // local checkout; registry builds bake in a CI path that won't exist on a
    // user's machine, so that candidate simply fails the exists() check.
    let dev_candidates = [
        work_dir.join(dev_entry),
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(dev_entry),
    ];
    for candidate in dev_candidates {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    report(
        status_id,
        LanguageServerInstallationStatus::CheckingForUpdate,
    );
    let installed = zed::npm_package_installed_version(package).inspect_err(|error| {
        report(
            status_id,
            LanguageServerInstallationStatus::Failed(error.clone()),
        );
    })?;

    if installed.as_deref() != Some(PACKAGE_VERSION) {
        report(status_id, LanguageServerInstallationStatus::Downloading);
        zed::npm_install_package(package, PACKAGE_VERSION).inspect_err(|error| {
            report(
                status_id,
                LanguageServerInstallationStatus::Failed(error.clone()),
            );
        })?;
    }

    report(status_id, LanguageServerInstallationStatus::None);
    Ok(work_dir.join(installed_entry))
}

impl zed::Extension for TypeGpuInspectorExtension {
    fn new() -> Self {
        Self
    }

    fn language_server_command(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Command> {
        if language_server_id.as_ref() != SERVER_ID {
            return Err(format!(
                "unsupported language server id: {language_server_id:?}"
            ));
        }

        let settings = LspSettings::for_worktree(SERVER_ID, worktree)?;
        let mut command = zed::node_binary_path()?;
        let mut args = vec![String::new(), "--stdio".into()];
        let mut env = EnvVars::default();

        let mut needs_default_server = true;
        if let Some(binary) = settings.binary {
            match (binary.path, binary.arguments) {
                (Some(path), Some(arguments)) => {
                    command = path;
                    args = arguments;
                    needs_default_server = false;
                }
                (None, None) => {}
                _ => {
                    return Err(
                        "typegpu-inspector binary.path and binary.arguments must be set together"
                            .into(),
                    );
                }
            }

            if let Some(binary_env) = binary.env {
                env = binary_env.into_iter().collect();
            }
        }

        if needs_default_server {
            let server = resolve_entry(
                Some(language_server_id),
                DEV_LANGUAGE_SERVER_ENTRY,
                LANGUAGE_SERVER_PACKAGE,
                LANGUAGE_SERVER_ENTRY,
            )?;
            args[0] = server.to_string_lossy().into_owned();
        }

        Ok(Command { command, args, env })
    }

    fn context_server_command(
        &mut self,
        context_server_id: &ContextServerId,
        _project: &Project,
    ) -> Result<Command> {
        if context_server_id.as_ref() != SERVER_ID {
            return Err(format!(
                "unsupported context server id: {context_server_id:?}"
            ));
        }

        // The same runtime inspector the language server launches, exposed as
        // a stdio MCP server for the Zed agent.
        let inspector = resolve_entry(
            None,
            DEV_INSPECTOR_ENTRY,
            INSPECTOR_PACKAGE,
            INSPECTOR_ENTRY,
        )?;

        Ok(Command {
            command: zed::node_binary_path()?,
            args: vec![inspector.to_string_lossy().into_owned()],
            env: EnvVars::default(),
        })
    }

    fn language_server_initialization_options(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<Value>> {
        let settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree)?;
        Ok(settings.initialization_options)
    }

    fn language_server_workspace_configuration(
        &mut self,
        language_server_id: &LanguageServerId,
        worktree: &Worktree,
    ) -> Result<Option<Value>> {
        // Return the whole initialization_options object so didChangeConfiguration
        // payloads match the shape the server parsed at initialize time. A nested
        // `settings` object is still honored for backwards compatibility.
        let settings = LspSettings::for_worktree(language_server_id.as_ref(), worktree)?;
        Ok(settings.initialization_options.as_ref().map(|value| {
            value
                .get("settings")
                .cloned()
                .unwrap_or_else(|| value.clone())
        }))
    }
}

zed::register_extension!(TypeGpuInspectorExtension);
