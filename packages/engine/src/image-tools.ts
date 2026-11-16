import { IMAGE_PROMPT_CHARS, IMAGE_SHAPES, type ImageShape } from "@agenteschat/providers";
import { fileLanded, SHARED_DRIVE_INPUT } from "./artifact-tools";
import { type ArtifactActor, type ArtifactDeps, cleanFileName, createFileArtifact } from "./artifacts";
import { BudgetExceededError, MissingCredentialError, PersonLimitError, TooManyError } from "./errors";
import type { ModelGateway } from "./gateway";
import { personBehindCall } from "./requester";
import { replyThreadOf } from "./runs";
import type { ToolContext, ToolDefinition, ToolOutput, ToolSource } from "./tools/types";

/**
 * `generate_image` (ADR 0213): a picture from words, for every brain (the model loop and the computer brains through
 * the bridge alike). Made only through the Model Gateway (`generateImage`), on the workspace's own OpenAI or Gemini
 * key, with the agent's budget held first and the cost recorded; saved in the Drive like an uploaded file and shown
 * on the reply as its card. Listed only while the workspace has such a key; its scope is the Drive's, `drive:write`.
 * Who may use it is the run policy's (`run-policy.ts`, kind `paid`): a routine's run asks a person first.
 */
export const GENERATE_IMAGE_TOOL = "generate_image";

export interface ImageToolDeps {
  gateway: Pick<ModelGateway, "imageProvider" | "generateImage">;
  artifacts: ArtifactDeps;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const isShape = (v: unknown): v is ImageShape => IMAGE_SHAPES.includes(v as ImageShape);

/** A title from the request's first words when the agent gave none. */
const titleOf = (prompt: string) => {
  const words = prompt.replace(/\s+/g, " ").trim();
  return words.length > 60 ? `${words.slice(0, 59).trimEnd()}…` : words;
};

/** Why no picture was made, in words the agent can pass on. */
function refusal(error: unknown): ToolOutput {
  if (error instanceof TooManyError) return { content: `${error.message} Tell the person.`, isError: true };
  if (error instanceof BudgetExceededError) {
    return {
      content: error.byReservations
        ? "Your monthly budget is held by work under way: try again in a moment."
        : "Your monthly budget can't pay for this image: no image was made. Tell the person; an admin can raise it.",
      isError: true,
    };
  }
  if (error instanceof PersonLimitError) {
    return { content: "The person who asked has used their monthly AI limit: no image was made.", isError: true };
  }
  if (error instanceof MissingCredentialError) return { content: error.message, isError: true };
  return {
    content: `No image was made: ${error instanceof Error ? error.message : String(error)}`,
    isError: true,
  };
}

function generateImageTool(deps: ImageToolDeps): ToolDefinition {
  return {
    name: GENERATE_IMAGE_TOOL,
    description:
      "Make a picture from a description (an illustration, a cover, a mock-up, an icon) when someone asks for one. It is saved in the Drive and its card goes with your reply, so don't describe or link it afterwards. Each image costs money from your budget: make one unless asked for more. Write `prompt` in English, detailed: subject, style, colors, composition and any text the picture must show.",
    scope: "drive:write",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          minLength: 1,
          maxLength: IMAGE_PROMPT_CHARS,
          description: "What the picture shows, in detail.",
        },
        shape: {
          type: "string",
          enum: [...IMAGE_SHAPES],
          description: "square (default), portrait (taller) or landscape (wider).",
        },
        title: { type: "string", maxLength: 200, description: "The file's name in the Drive." },
        shared_drive: SHARED_DRIVE_INPUT,
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    describe: (input) => ({ title: "Generate an image", detail: str(input.prompt).slice(0, 300) || undefined }),
    async execute(input, ctx) {
      const prompt = str(input.prompt).trim();
      if (!prompt) return { content: "Say what the picture shows in `prompt`.", isError: true };
      const shape = isShape(input.shape) ? input.shape : "square";
      let image: Awaited<ReturnType<ImageToolDeps["gateway"]["generateImage"]>>;
      try {
        image = await deps.gateway.generateImage({
          orgId: ctx.orgId,
          agentId: ctx.agentId,
          runId: ctx.runId || undefined,
          personId: await personBehindCall(ctx),
          prompt,
          shape,
          signal: ctx.signal,
        });
      } catch (error) {
        return refusal(error);
      }
      try {
        const title = str(input.title).trim() || titleOf(prompt);
        const ext = image.contentType === "image/jpeg" ? "jpg" : image.contentType.slice("image/".length);
        const a = await createFileArtifact(deps.artifacts, actorOf(ctx), ctx.orgId, {
          title,
          name: `${cleanFileName(title)}.${ext}`,
          bytes: image.bytes,
          contentType: image.contentType,
        });
        return {
          content: `Made the image "${a.title}" and saved it as artifact ${a.id}; its card goes with your reply. ${await fileLanded(deps.artifacts, ctx, a.id, input.shared_drive)}`,
          data: {
            artifact: { id: a.id, version: a.version, title: a.title },
            image: { provider: image.provider, model: image.model, costNanoUsd: image.costNanoUsd },
          },
        };
      } catch (error) {
        // Made and paid for, but not kept: say so, so the agent doesn't make it again without telling anyone.
        return {
          content: `The image was made but couldn't be saved in the Drive: ${error instanceof Error ? error.message : String(error)}. Tell the person before making another.`,
          isError: true,
        };
      }
    },
  };
}

const actorOf = (ctx: ToolContext): ArtifactActor => ({
  type: "agent",
  agentId: ctx.agentId,
  channelId: ctx.channelId,
  threadId: replyThreadOf(ctx),
  runId: ctx.runId,
});

/** `generate_image` while the workspace has a key an image provider takes (`gateway.imageProvider`). */
export function createImageToolSource(deps: ImageToolDeps): ToolSource {
  const tool = generateImageTool(deps);
  return {
    name: "images",
    async tools(ctx) {
      return (await deps.gateway.imageProvider(ctx.orgId)) ? [tool] : [];
    },
  };
}
