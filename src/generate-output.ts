/**
 * Custom output formatter that replaces Agentation's built-in generateOutput.
 * Produces the exact format specified for Linear issue creation.
 */
export function generateOutput(
  annotations: any[],
  pathname: string,
  detailLevel: string = "standard",
  reactMode: string = "filtered"
): string {
  if (annotations.length === 0) return "";

  const url = typeof window !== "undefined" ? window.location.href : pathname;
  const viewport = typeof window !== "undefined"
    ? `${window.innerWidth}x${window.innerHeight}`
    : "unknown";
  const browser = typeof navigator !== "undefined" ? navigator.userAgent : "unknown";

  let output = "";

  // Header metadata
  output += `**Page:** ${url}\n`;
  output += `**Viewport:** ${viewport}\n`;
  output += `**Browser:** ${browser}\n`;
  output += `\n---\n\n`;
  output += `## Annotations\n\n`;

  annotations.forEach((a: any, i: number) => {
    const noteLabel = a.comment ? a.comment : "(no note)";
    output += `### ${i + 1}. ${noteLabel}\n`;

    // Element name
    output += `- **Element:** ${a.element}\n`;

    // Selector — use fullPath if available, fallback to elementPath
    if (a.fullPath) {
      output += `- **Selector:** \`${a.fullPath}\`\n`;
    } else if (a.elementPath) {
      output += `- **Selector:** \`${a.elementPath}\`\n`;
    }

    // Path
    if (a.elementPath) {
      output += `- **Path:** \`${a.elementPath}\`\n`;
    }

    // Position
    if (a.boundingBox) {
      const b = a.boundingBox;
      output += `- **Position:** ${Math.round(b.x)}, ${Math.round(b.y)}, ${Math.round(b.width)}×${Math.round(b.height)}\n`;
    }

    // Text content
    if (a.selectedText) {
      output += `- **Text content:** ${a.selectedText}\n`;
    } else if (a.nearbyText) {
      output += `- **Text content:** ${a.nearbyText}\n`;
    }

    // Computed styles
    if (a.computedStyles) {
      output += `- **Styles:** ${a.computedStyles}\n`;
    }

    output += "\n";
  });

  return output.trim();
}
