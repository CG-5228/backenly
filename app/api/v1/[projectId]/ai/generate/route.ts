export const dynamic = 'force-dynamic'

import { NextRequest } from 'next/server'
import { v1ApiMiddleware, requirePermission, requireCapability } from '@/lib/api/v1/middleware'
import { createErrorResponse, createSuccessResponse, handleValidationError, ErrorCodes } from '@/lib/api/v1/errors'
import { aiGenerateSchema } from '@/lib/api/v1/schemas'
import { validateRequestBody } from '@/lib/validation/schemas'
import { recordedV1 } from '@/lib/traffic/recorded-v1'
import { generateForProject } from '@/lib/ai/runtime-generate'

/**
 * POST /v1/{projectId}/ai/generate
 * Generate text with the deployment's AI provider, charged to the project's AI
 * credits. `model` is an alias ("fast", or anything else for the default);
 * `temperature` is accepted and ignored. lib/ai/runtime-generate.ts has the
 * rules.
 */
async function handlePOST(request: NextRequest, props: { params: Promise<{ projectId: string }> }) {
  const params = await props.params
  try {
    const middleware = await v1ApiMiddleware(request, params)
    if (middleware.response) {
      return middleware.response
    }

    const { context } = middleware

    // AI actions require 'ai-only' or 'admin' permission
    const permissionCheck = requirePermission(context, ['ai-only', 'admin'])
    if (permissionCheck) {
      return permissionCheck
    }

    const capabilityCheck = requireCapability(context, request.nextUrl.pathname)
    if (capabilityCheck) {
      return capabilityCheck
    }

    const validation = await validateRequestBody(aiGenerateSchema, request)
    if (!validation.success) {
      return handleValidationError((validation as { success: false; error: string; status: number }).error as any)
    }

    const { prompt, model, maxTokens } = validation.data
    const result = await generateForProject({ projectId: context.projectId, prompt, model, maxTokens })
    if ('data' in result) return createSuccessResponse(result.data)
    return createErrorResponse(result.code, result.message, result.status, result.details)
  } catch (error) {
    console.error('AI generate error:', error)
    return createErrorResponse(ErrorCodes.INTERNAL_ERROR, 'Failed to generate content', 500)
  }
}

export const POST = recordedV1(handlePOST)
