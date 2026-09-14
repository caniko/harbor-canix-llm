{
  description = "Canix-specific LLM harness orchestration and trusted dev-shell switching";

  inputs = {
    harbor-meta.url = "git+https://github.com/caniko/harbor-meta.git?rev=9e4e085ae399e7b39482a5b8e11df78a9ebd4e59";
    nixpkgs.follows = "harbor-meta/nixpkgs";
  };

  outputs = {
    self,
    nixpkgs,
    harbor-meta,
  }: let
    forSystems = nixpkgs.lib.genAttrs ["x86_64-linux" "aarch64-linux"];
  in {
    lib.patchOpencode = package:
      package.overrideAttrs (old: {
        patches = (old.patches or []) ++ [./patches/opencode-shell-environment.patch];
        passthru = (old.passthru or {}) // {harborCanixLlmEnvironmentVersion = 1;};
      });
    homeManagerModules.default = import ./nix/home.nix self;
    packages = forSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = pkgs.stdenvNoCC.mkDerivation {
        pname = "harbor-canix-llm";
        version = "0.1.0";
        src = builtins.path {
          path = ./.;
          name = "harbor-canix-llm-source";
          filter = path: _: !builtins.elem (baseNameOf path) [".git" "node_modules" ".direnv" ".nix-results" "result" "graphify-out"];
        };
        nativeBuildInputs = [pkgs.nodejs pkgs.importNpmLock.npmConfigHook];
        npmDeps = pkgs.importNpmLock {npmRoot = ./.;};
        installPhase = ''
          mkdir -p $out/lib/harbor-canix-llm
          cp -r src node_modules package.json $out/lib/harbor-canix-llm/
        '';
      };
    });
    devShells = forSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      default = harbor-meta.lib.devShell.mkShell {
        inherit pkgs;
        packages = [pkgs.nodejs pkgs.alejandra];
      };
    });
    checks = forSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};
    in {
      environments = pkgs.runCommand "harbor-canix-llm-environments" {nativeBuildInputs = [pkgs.nodejs];} ''
        cp -r ${./src} src
        cp -r ${./test} test
        node --test test/*.test.mjs
        touch $out
      '';
      plugin = pkgs.runCommand "harbor-canix-llm-plugin" {nativeBuildInputs = [pkgs.nodejs];} ''
        node --input-type=module -e '
          import assert from "node:assert/strict";
          import {HarborCanixLlm} from "${self.packages.${system}.default}/lib/harbor-canix-llm/src/opencode.mjs";
          const plugin = await HarborCanixLlm({}, {registry: "${./test/empty-registry.json}"});
          assert.equal(await plugin.tool.harbor_devshell.execute({action: "list"}, {sessionID: "test"}), "[]");
          assert.equal(typeof plugin["shell.env"], "function");
        '
        touch $out
      '';
      shell = harbor-meta.lib.devShellTests.mkCheck {
        inherit pkgs;
        name = "harbor-canix-llm-dev-shell";
        shell = self.devShells.${system}.default;
        commands = ["node" "npm"];
      };
    });
    formatter = forSystems (system: nixpkgs.legacyPackages.${system}.alejandra);
  };
}
