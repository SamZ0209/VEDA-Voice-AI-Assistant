
import asyncio
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


SERVER_PATH = Path(__file__).with_name("mcp_server.py")


async def main():
    if not SERVER_PATH.is_file():
        raise FileNotFoundError(
            f"MCP server file not found: {SERVER_PATH}"
        )

    server = StdioServerParameters(
        command=sys.executable,
        args=[str(SERVER_PATH)],
    )

    async with stdio_client(server) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()

            # Discover available tools while the session is open.
            tools_result = await session.list_tools()

            print("MCP connection successful.")
            print("Tools discovered:")

            for tool in tools_result.tools:
                print(f"- {tool.name}: {tool.description}")

            # Test the actual folder-creation tool.
            result = await session.call_tool(
                "create_desktop_folder",
                {"name": "MCP Server Test"},
            )

            print("\nTool error:", result.isError)

            for item in result.content:
                if hasattr(item, "text"):
                    print(item.text)


if __name__ == "__main__":
    asyncio.run(main())
