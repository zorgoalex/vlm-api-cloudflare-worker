export const OPENAPI_YAML = `openapi: 3.0.3
info:
  title: VLMM Worker API
  version: 1.0.0
  description: >-
    Cloudflare Worker for Vision and Prompts management.
servers:
  - url: http://127.0.0.1:8787
  - url: https://{account}.workers.dev
paths:
  /v1/prompts:
    get:
      summary: List prompts
      parameters:
        - in: query
          name: namespace
          schema: { type: string, default: "default" }
        - in: query
          name: lang
          schema: { type: string }
        - in: query
          name: active
          schema: { type: string, enum: ["0", "1"] }
        - in: query
          name: q
          schema: { type: string }
        - in: query
          name: tag
          schema: { type: string }
        - in: query
          name: limit
          schema: { type: integer, minimum: 1, maximum: 100, default: 50 }
        - in: query
          name: offset
          schema: { type: integer, minimum: 0, default: 0 }
      responses:
        '200':
          description: List of prompts
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Prompt'
        '401': { $ref: '#/components/responses/Unauthorized' }
    post:
      summary: Create prompt
      security:
        - AdminToken: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/PromptCreate'
      responses:
        '201':
          description: Created
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: integer }
        '400': { $ref: '#/components/responses/BadRequest' }
        '401': { $ref: '#/components/responses/Unauthorized' }
  /v1/prompts/{id}:
    get:
      summary: Get prompt by id
      parameters:
        - in: path
          name: id
          required: true
          schema: { type: integer }
      responses:
        '200':
          description: Prompt
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Prompt'
        '401': { $ref: '#/components/responses/Unauthorized' }
        '404': { $ref: '#/components/responses/NotFound' }
    put:
      summary: Update prompt
      security:
        - AdminToken: []
      parameters:
        - in: path
          name: id
          required: true
          schema: { type: integer }
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/PromptUpdate'
      responses:
        '200': { description: Updated }
        '400': { $ref: '#/components/responses/BadRequest' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '404': { $ref: '#/components/responses/NotFound' }
  /v1/prompts/{id}/default:
    put:
      summary: Set prompt as default
      security:
        - AdminToken: []
      parameters:
        - in: path
          name: id
          required: true
          schema: { type: integer }
      responses:
        '200': { description: Default set }
        '400': { $ref: '#/components/responses/BadRequest' }
        '401': { $ref: '#/components/responses/Unauthorized' }
        '404': { $ref: '#/components/responses/NotFound' }
  /v1/prompts/default:
    get:
      summary: Get default prompt for namespace/lang
      parameters:
        - in: query
          name: namespace
          schema: { type: string, default: "default" }
        - in: query
          name: lang
          schema: { type: string, default: "ru" }
      responses:
        '200':
          description: Default prompt
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Prompt'
        '401': { $ref: '#/components/responses/Unauthorized' }
        '404': { $ref: '#/components/responses/NotFound' }
components:
  securitySchemes:
    AdminToken:
      type: apiKey
      in: header
      name: X-Admin-Token
    ReadBearer:
      type: http
      scheme: bearer
  schemas:
    Prompt:
      type: object
      properties:
        id: { type: integer }
        namespace: { type: string }
        name: { type: string }
        version: { type: integer }
        lang: { type: string }
        text: { type: string }
        tags:
          type: array
          items: { type: string }
        is_active: { type: integer, enum: [0,1] }
        is_default: { type: integer, enum: [0,1] }
        created_at: { type: string, format: date-time }
        updated_at: { type: string, format: date-time }
    PromptCreate:
      type: object
      required: [name, text]
      properties:
        namespace: { type: string, default: "default" }
        name: { type: string }
        version: { type: integer, default: 1 }
        lang: { type: string, default: "ru" }
        text: { type: string }
        tags:
          type: array
          items: { type: string }
        is_active: { type: integer, enum: [0,1], default: 1 }
        make_default: { type: boolean, default: false }
    PromptUpdate:
      type: object
      properties:
        namespace: { type: string }
        name: { type: string }
        version: { type: integer }
        lang: { type: string }
        text: { type: string }
        tags:
          type: array
          items: { type: string }
        is_active: { type: integer, enum: [0,1] }
    Error:
      type: object
      properties:
        error: { type: string }
        code: { type: string }
        request_id: { type: string }
  responses:
    BadRequest:
      description: Bad request
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Error' }
    Unauthorized:
      description: Unauthorized
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Error' }
    NotFound:
      description: Not found
      content:
        application/json:
          schema: { $ref: '#/components/schemas/Error' }
`;

