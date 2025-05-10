function buildTree(paths, rootPath, branch) {
  const root = { children: {}, branch };
  for (const fullPath of paths) {
    const relativePath = path.relative(rootPath, fullPath);
    const parts = relativePath.split(path.sep);
    let current = root;
    for (const part of parts) {
      current.children[part] = current.children[part] || { children: {}, branch };
      current = current.children[part];
    }
    current.fullPath = fullPath;
  }
  return root;
}

function buildFileNode(node, label) {
  const isLeaf = !node || Object.keys(node.children || {}).length === 0;
  const collapsibleState = isLeaf
    ? vscode.TreeItemCollapsibleState.None
    : vscode.TreeItemCollapsibleState.Collapsed;
  const item = new FileNode(label, node.fullPath || "", collapsibleState, node.branch);
  item["children"] = node.children;
  return item;
}

module.exports = { buildTree, buildFileNode };