import React, { useMemo } from "react";
import { Platform, TFile, TFolder } from "obsidian";
import { FileText, Wrench, Folder, Globe } from "lucide-react";
import { TypeaheadOption } from "../TypeaheadMenuContent";
import type { WebTabContext } from "@/types/message";

export type AtMentionCategory =
  | "notes"
  | "tools"
  | "folders"
  | "activeNote"
  | "webTabs"
  | "activeWebTab";

export interface AtMentionOption extends TypeaheadOption {
  category: AtMentionCategory;
  data: TFile | string | TFolder | WebTabContext;
}

export interface CategoryOption extends TypeaheadOption {
  category: AtMentionCategory;
  icon: React.ReactNode;
}

export const CATEGORY_OPTIONS: CategoryOption[] = [
  {
    key: "notes",
    title: "Notes",
    subtitle: "Reference notes in your vault",
    category: "notes",
    icon: <FileText className="tw-size-4" />,
  },
  {
    key: "webTabs",
    title: "Web Tabs",
    subtitle: "Reference open browser tabs",
    category: "webTabs",
    icon: <Globe className="tw-size-4" />,
  },
  {
    key: "tools",
    title: "Tools",
    subtitle: "AI tools and commands",
    category: "tools",
    icon: <Wrench className="tw-size-4" />,
  },
  {
    key: "folders",
    title: "Folders",
    subtitle: "Reference vault folders",
    category: "folders",
    icon: <Folder className="tw-size-4" />,
  },
];

/**
 * Hook that provides available @ mention categories based on feature support.
 * Returns the array of available category options directly.
 * Web Tabs category is only available on desktop (Web Viewer not supported on mobile).
 *
 * @param isCopilotPlus - Whether Copilot Plus features are enabled
 * @param showTools - Whether tool mentions should be shown
 * @returns Array of CategoryOption objects
 */
export function useAtMentionCategories(
  isCopilotPlus: boolean = false,
  showTools: boolean = isCopilotPlus
): CategoryOption[] {
  return useMemo(() => {
    return CATEGORY_OPTIONS.filter((cat) => {
      // Tools can be shown for Plus chains or local tool-capable chains.
      if (cat.category === "tools") {
        return showTools;
      }
      // Web Tabs only available on desktop (Web Viewer not supported on mobile)
      if (cat.category === "webTabs") {
        return Platform.isDesktopApp;
      }
      return true;
    });
  }, [showTools]);
}
