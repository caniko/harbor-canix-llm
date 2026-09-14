self: {
  config,
  lib,
  pkgs,
  ...
}: let
  cfg = config.programs.harborCanixLlm;
  registry = pkgs.writeText "harbor-canix-llm-registry.json" (builtins.toJSON {
    version = 1;
    projects =
      lib.mapAttrsToList (name: project: {
        inherit name;
        inherit (project) root;
        shells = lib.mapAttrs (_: shell: shell.drvPath) project.shells;
      })
      cfg.projects;
  });
  runtime = "${cfg.package}/lib/harbor-canix-llm/src";
  opencodeSettings = {
    plugin = [
      [
        "${runtime}/opencode.mjs"
        {
          inherit registry;
          nix = lib.getExe pkgs.nix;
          node = lib.getExe pkgs.nodejs;
          capture = "${runtime}/capture.mjs";
        }
      ]
    ];
    permission = {
      harbor_devshell = "allow";
      harbor_dev_shell_prepare = "ask";
    };
  };
in {
  options.programs.harborCanixLlm = {
    enable = lib.mkEnableOption "Canix LLM harness orchestration";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
    };
    projects = lib.mkOption {
      default = {};
      description = "Operator-approved canonical project roots and immutable dev-shell derivations. This trusts their builds and shell hooks, not just their names.";
      type = lib.types.attrsOf (lib.types.submodule {
        options = {
          root = lib.mkOption {type = lib.types.str;};
          shells = lib.mkOption {type = lib.types.attrsOf lib.types.package;};
        };
      });
    };
    opencode.enable = lib.mkEnableOption "OpenCode environment replacement adapter";
    opencode.configFile = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      default = pkgs.writeText "harbor-canix-llm-opencode.json" (builtins.toJSON opencodeSettings);
      description = "Harbor-only configuration overlay for a scoped backend rollout through OPENCODE_CONFIG, without replacing unrelated harness settings.";
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = pkgs.stdenv.hostPlatform.isLinux;
        message = "harbor-canix-llm currently supports Linux only";
      }
      {
        assertion = !cfg.opencode.enable || config.programs.opencode.enable;
        message = "Enable OpenCode before enabling its harbor-canix-llm adapter";
      }
      {
        assertion = !cfg.opencode.enable || (config.programs.opencode.package.harborCanixLlmEnvironmentVersion or 0) == 1;
        message = "Apply harbor-canix-llm.lib.patchOpencode to the actual OpenCode runtime and preserve its environment-version passthru on wrappers";
      }
    ];
    programs.opencode.settings = lib.mkIf cfg.opencode.enable opencodeSettings;
  };
}
