const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const simpleGit = require("simple-git");
const { buildTree, buildFileNode } = require("./src/utils");

let markedFiles = new Set();
let branchTagMap = new Map();
let treeViewMode = "flat";
let currentBranch = "";

// 获取当前 Git 分支
async function getCurrentGitBranch(url) {
  // @ts-ignore
  const git = simpleGit(url);
  try {
    const branchSummary = await git.status();
    return branchSummary.current;
  } catch (error) {
    return branchTagMap.length;
  }
}

class FileNode extends vscode.TreeItem {
  constructor(label, fullPath, collapsibleState, branch) {
    super(label);
    this.fullPath = fullPath;
    this.branch = branch;
    this.collapsibleState = collapsibleState;
    this.command =
      fullPath && collapsibleState === vscode.TreeItemCollapsibleState.None
        ? {
            command: "vscode.open",
            title: "Open File",
            arguments: [vscode.Uri.file(fullPath)],
          }
        : undefined;
    this.contextValue = "fileNode";
    if (fullPath) {
      this.resourceUri = vscode.Uri.file(fullPath);
    } else {
      this.iconPath = new vscode.ThemeIcon("folder");
    }
  }
}

class MarkedFilesProvider {
  constructor(workspaceRoot) {
    this.workspaceRoot = workspaceRoot;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  setFilter(filter) {
    this.filter = filter;
    this.refresh();
  }

  getChildren(element) {
    const filterFiles = (files) =>
      this.filter ? files.filter((file) => file.includes(this.filter)) : files;

    if (treeViewMode === "flat") {
      if (!element) {
        return Array.from(branchTagMap)
          .map(([key, value]) => {
            const filtered = filterFiles(Array.from(value));
            if (filtered.length === 0) return null;
            const item = new FileNode(
              key,
              "",
              vscode.TreeItemCollapsibleState.Collapsed,
              key
            );
            item["children"] = filtered;
            return item;
          })
          .filter(Boolean);
      } else {
        return filterFiles(Array.from(element.children)).map((file) => {
          const relative = path.relative(this.workspaceRoot, file);
          return new FileNode(
            relative,
            file,
            vscode.TreeItemCollapsibleState.None,
            element.branch
          );
        });
      }
    }

    if (!element) {
      const root = { children: {} };
      branchTagMap.forEach((files, branch) => {
        root.children[branch] = { children: {}, branch: branch };
        const tree = buildTree(Array.from(files), this.workspaceRoot, branch);
        root.children[branch]["children"] = tree.children;
      });
      const data = Object.keys(root.children).map((name) =>
        buildFileNode(root.children[name], name)
      );
      return data;
    } else {
      const children = element.children || {};
      return Object.keys(children).map((name) =>
        buildFileNode(children[name], name)
      );
    }
  }

  getTreeItem(element) {
    return element;
  }
}

// async function getAllFilesRecursively(dir) {
//   const result = [];
//   async function walk(currentPath) {
//     const entries = fs.readdirSync(currentPath, { withFileTypes: true });
//     for (const entry of entries) {
//       const entryPath = path.join(currentPath, entry.name);
//       if (entry.isDirectory()) {
//         await walk(entryPath);
//       } else {
//         result.push(entryPath);
//       }
//     }
//   }
//   await walk(dir);
//   return result;
// }

async function getAllFilesRecursively(dir) {
  const result = [];
  async function walk(currentPath) {
    const entries = await fs.promises.readdir(currentPath, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else {
        result.push(entryPath);
      }
    }
  }
  await walk(dir);
  return result;
}

function deleteFolder(fileNode) {
  if (!fileNode.children || Object.keys(fileNode.children).length === 0) {
    branchTagMap.get(fileNode.branch).delete(fileNode.fullPath);
  } else {
    Object.keys(fileNode.children).forEach(function (key) {
      deleteFolder(fileNode.children[key]);
    });
  }
}

function saveData(context) {
  const workspaceState = context.workspaceState;
  const dataToSave = {
    markedFiles: Array.from(markedFiles),
    branchTagMap: Object.fromEntries(
      Array.from(branchTagMap.entries()).map(([key, value]) => [
        key,
        Array.from(value),
      ])
    ),
    treeViewMode: treeViewMode,
  };
  workspaceState.update("markedFilesData", dataToSave);
}

async function activate(context) {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage("请先打开一个工作区文件夹");
    return;
  }

  // 从持久化存储中加载数据
  const savedData = context.workspaceState.get("markedFilesData", {
    markedFiles: [],
    branchTagMap: {},
    treeViewMode: "flat",
  });

  // 恢复数据
  markedFiles = new Set(savedData.markedFiles);
  branchTagMap = new Map(
    Object.entries(savedData.branchTagMap || {}).map(([key, value]) => [
      key,
      new Set(value),
    ])
  );
  treeViewMode = savedData.treeViewMode;

  const provider = new MarkedFilesProvider(workspaceRoot);
  vscode.window.registerTreeDataProvider("marked-files", provider);

  let treeView = vscode.window.createTreeView("marked-files", {
    treeDataProvider: provider,
  });

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "MarkView.markFileOrFolder",
      async (uri) => {
        currentBranch = await getCurrentGitBranch(workspaceRoot);

        if (!uri) return;
        let pathsToAdd = [];
        const stat = fs.lstatSync(uri.fsPath);
        if (stat.isDirectory()) {
          pathsToAdd = await getAllFilesRecursively(uri.fsPath);
        } else {
          pathsToAdd = [uri.fsPath];
        }

        for (const p of pathsToAdd) markedFiles.add(p);

        if (currentBranch) {
          if (!branchTagMap.has(currentBranch)) {
            branchTagMap.set(currentBranch, new Set());
          }
          pathsToAdd.forEach((path) => {
            branchTagMap.get(currentBranch).add(path);
          });
        }

        provider.refresh();
        saveData(context);
      }
    ),

    vscode.commands.registerCommand(
      "MarkView.removeMarkedItem",
      async (item) => {
        deleteFolder(item);
        if (branchTagMap.get(item.branch).size === 0) {
          branchTagMap.delete(item.branch);
        }
        provider.refresh();
        saveData(context);
      }
    ),

    vscode.commands.registerCommand("MarkView.switchToFlat", () => {
      treeViewMode = "flat";
      provider.refresh();
      saveData(context);
    }),

    vscode.commands.registerCommand("MarkView.switchToTree", () => {
      treeViewMode = "tree";
      provider.refresh();
      saveData(context);
    }),

    vscode.commands.registerCommand("MarkView.filterFiles", async () => {
      const filter = await vscode.window.showInputBox({
        prompt: "输入文件名筛选",
      });
      if (filter !== undefined) provider.setFilter(filter);
    })
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
