import { Controller, Inject, Param, Put, Req, Res } from "@nestjs/common";
import { Request, Response } from "express";
import { RequireService } from "@docbridge/auth-core";
import { DeliverDocumentResponse } from "@docbridge/contracts";
import { DocumentsService } from "./documents.service";

@Controller("folders")
export class DocumentsController {
  constructor(
    @Inject(DocumentsService)
    private readonly documents: DocumentsService,
  ) {}

  @Put(":folderId/documents")
  @RequireService("documents:write")
  async deliver(
    @Param("folderId") folderId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<DeliverDocumentResponse> {
    const body = await this.documents.deliver(folderId, req);
    res.status(body.alreadyDelivered ? 200 : 201);
    return body;
  }
}
