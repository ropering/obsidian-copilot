import { ChatModelProviders, ChatModels } from "@/constants";
import { getSettings, resetSettings, setSettings } from "@/settings/model";

describe("Desktop Codex CLI built-in model settings", () => {
  beforeEach(() => {
    resetSettings();
  });

  afterEach(() => {
    resetSettings();
  });

  it("adds the Desktop Codex CLI model to existing settings while allowing disable", () => {
    const settingsWithoutCodex = {
      ...getSettings(),
      activeModels: getSettings().activeModels.filter(
        (model) => model.provider !== ChatModelProviders.DESKTOP_CODEX_CLI
      ),
    };

    setSettings(settingsWithoutCodex);

    const addedModel = getSettings().activeModels.find(
      (model) =>
        model.name === ChatModels.DESKTOP_CODEX_CLI_CHAT &&
        model.provider === ChatModelProviders.DESKTOP_CODEX_CLI
    );

    expect(addedModel).toBeTruthy();
    expect(addedModel?.enabled).toBe(true);
    expect(addedModel?.core).toBe(false);

    setSettings({
      activeModels: getSettings().activeModels.map((model) =>
        model.provider === ChatModelProviders.DESKTOP_CODEX_CLI
          ? { ...model, enabled: false }
          : model
      ),
    });

    const disabledModel = getSettings().activeModels.find(
      (model) => model.provider === ChatModelProviders.DESKTOP_CODEX_CLI
    );
    expect(disabledModel?.enabled).toBe(false);
  });
});
