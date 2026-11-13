
from pathlib import Path

from mcp.server.mcpserver import MCPServer


mcp = MCPServer("ai assistant files")

DESKTOP = Path.home() / "Desktop"


@mcp.tool()
def create_desktop_folder(name: str) -> str:
    """Create a new folder directly on the user's Desktop.

    Only creates one folder at the top level of Desktop.
    Does not overwrite, rename, or delete existing items.
    """
    name = name.strip()

    if not name:
        raise ValueError("The folder name cannot be empty.")

    # Accept only a single folder name, not a path.
    if (
        name in {".", ".."}
        or "/" in name
        or "\\" in name
        or Path(name).name != name
    ):
        raise ValueError(
            "Provide a folder name only, not a file path."
        )

    if not DESKTOP.is_dir():
        raise RuntimeError(
            f"The Desktop directory was not found: {DESKTOP}"
        )

    desktop = DESKTOP.resolve()
    target = desktop / name

    # Verify that the target is a direct child of Desktop.
    if target.parent.resolve() != desktop:
        raise ValueError("The folder must be directly on Desktop.")

    if target.exists():
        if target.is_dir():
            return (
                f"A folder named '{name}' already exists "
                "on the Desktop. No changes were made."
            )

        return (
            f"An item named '{name}' already exists on the "
            "Desktop and is not a folder. No changes were made."
        )

    target.mkdir()

    return f"Successfully created folder '{name}' on the Desktop."


if __name__ == "__main__":
    mcp.run(transport="stdio")
