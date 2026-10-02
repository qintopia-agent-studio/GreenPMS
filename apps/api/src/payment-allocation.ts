import { Type } from '@sinclair/typebox';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@qintopia/db';
import { listPaymentAllocations, type PaymentAllocationQuery } from '../../../packages/db/src/payment-allocation.ts';
import { listRetainedFunds, type RetainedFundsQuery } from '../../../packages/db/src/retained-funds.ts';
import { requirePrincipal, requirePropertyAccess } from './auth.ts';
import { ErrorResponse, Id } from './schemas.ts';
const opt=(schema:ReturnType<typeof Type.String>)=>Type.Optional(schema);
const nullableId=Type.Union([Id,Type.Null()]);
const int=Type.Integer({minimum:0,maximum:2147483647});
const common={enabled:Type.Boolean(),hasMore:Type.Boolean(),nextBeforeId:nullableId};
const allocationItem=Type.Object({id:Id,kind:Type.Union([Type.Literal('COLLECTION'),Type.Literal('REFUND')]),reference:Type.String(),originalTransactionReference:Type.Union([Type.String(),Type.Null()]),
  amountMinor:Type.Union([int,Type.Null()]),occurredAt:Type.String(),nickname:Type.Union([Type.String(),Type.Null()]),
  status:Type.Union(['AVAILABLE','PARTIALLY_MATCHED','MATCHED','HISTORICAL','REVIEW','PENDING','UNVERIFIED'].map(x=>Type.Literal(x))),orderId:nullableId,membershipOrderId:nullableId,recommendationReasons:Type.Array(Type.String()),
  allocatedMinor:int,remainingMinor:int,allocations:Type.Array(Type.Object({id:Id,orderId:Id,factId:Id,amountMinor:int,released:Type.Boolean(),createdAt:Type.String()}))});
const retainedItem=Type.Object({id:Id,propertyId:Id,sourceOrderId:Id,sourceFactId:Id,billId:Id,ownerName:Type.String(),ownerContact:Type.String(),confirmationNote:Type.String(),
  amountMinor:int,usedMinor:int,refundedMinor:int,releasedMinor:int,remainingMinor:int,createdAt:Type.String()});
export function registerPaymentAllocation(app:FastifyInstance,db:Kysely<Database>){
  app.get('/api/v2/external-payments',{schema:{tags:['queries'],querystring:Type.Object({propertyId:Id,kind:Type.Union([Type.Literal('COLLECTION'),Type.Literal('REFUND')]),
    recommended:Type.Optional(Type.Boolean()),amountMinor:Type.Optional(Type.Integer({minimum:1,maximum:2147483647})),query:opt(Type.String({maxLength:200})),
    status:Type.Optional(Type.Union(['AVAILABLE','PARTIALLY_MATCHED','ALL','MATCHED','HISTORICAL'].map(x=>Type.Literal(x)))),begin:opt(Type.String({format:'date-time'})),end:opt(Type.String({format:'date-time'})),
    beforeId:Type.Optional(Id),billId:Type.Optional(Id),originalCollectionFactId:Type.Optional(Id),limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))},{additionalProperties:false}),
    response:{200:Type.Object({...common,lastSyncedAt:Type.Union([Type.String(),Type.Null()]),synchronizationError:Type.Boolean(),items:Type.Array(allocationItem)}),400:ErrorResponse,401:ErrorResponse,403:ErrorResponse,404:ErrorResponse,500:ErrorResponse}}},async(request,reply)=>{
      const q=request.query as Omit<PaymentAllocationQuery,'begin'|'end'>&{propertyId:string;begin?:string;end?:string};
      requirePropertyAccess(await requirePrincipal(db,request),q.propertyId,'READ');reply.header('Cache-Control','no-store');
      const {begin,end,...query}=q;
      return listPaymentAllocations(db,q.propertyId,{...query,...(begin?{begin:new Date(begin)}:{}),...(end?{end:new Date(end)}:{})});
    });
  app.get('/api/v2/retained-funds',{schema:{tags:['queries'],querystring:Type.Object({propertyId:Id,query:opt(Type.String({maxLength:200})),orderId:Type.Optional(Id),
    status:Type.Optional(Type.Union([Type.Literal('AVAILABLE'),Type.Literal('ALL')])),beforeId:Type.Optional(Id),retainedFundId:Type.Optional(Id),limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))},{additionalProperties:false}),
    response:{200:Type.Object({...common,items:Type.Array(retainedItem)}),400:ErrorResponse,401:ErrorResponse,403:ErrorResponse,500:ErrorResponse}}},async(request,reply)=>{
      const q=request.query as RetainedFundsQuery&{propertyId:string};requirePropertyAccess(await requirePrincipal(db,request),q.propertyId,'READ');reply.header('Cache-Control','no-store');
      return listRetainedFunds(db,q.propertyId,q);
    });
}
