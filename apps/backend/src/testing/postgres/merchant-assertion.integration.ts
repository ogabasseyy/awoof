import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createTestPool, inTransaction } from './test-database.js';
import { grantMerchantDisclosure, grantVerificationProcessing, withdrawConsent } from '../../services/verification/eligibility-consent.service.js';
import { updateInstitutionPolicy } from '../../services/verification/eligibility-policy.service.js';
import { lockStudentContext } from '../../services/verification/eligibility-context.service.js';
import { requestChallenge, consumeChallenge } from '../../services/verification/challenge.service.js';
import { applyEnrollmentDecision, beginEnrollmentCheck, recordEmailAssurance } from '../../services/verification/eligibility-evidence.service.js';
import { ENROLLMENT_SOURCE } from '../../services/verification/eligibility.types.js';
import { MERCHANT_DISCLOSURE_NOTICE_VERSION, VERIFICATION_NOTICE_VERSION } from '../../services/verification/verification-notices.js';
import { rotateReportingKey } from '../../services/auth/reporting-key.service.js';
import { issueMerchantAssertion, exchangeMerchantAssertion } from '../../services/verification/merchant-assertion.service.js';

test('merchant assertion issuance rejects an email-only student without current enrollment evidence', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const label = randomUUID();
        const student = (await client.query('INSERT INTO users (email,role) VALUES ($1,$2) RETURNING id', [`student-${label}@students.example`,'student'])).rows[0].id as string;
        const owner = (await client.query('INSERT INTO users (email,role) VALUES ($1,$2) RETURNING id', [`vendor-${label}@example.invalid`,'vendor'])).rows[0].id as string;
        const admin = (await client.query('INSERT INTO users (email,role) VALUES ($1,$2) RETURNING id', [`admin-${label}@example.invalid`,'admin'])).rows[0].id as string;
        const university = (await client.query('INSERT INTO universities (name,is_active) VALUES ($1,true) RETURNING id',[label])).rows[0].id;
        await client.query('INSERT INTO students (user_id,name,university_id) VALUES ($1,$2,$3)',[student,label,university]);
        await inTransaction(client,()=>updateInstitutionPolicy(client,admin,university,{
            domains:['students.example'], emailEvidenceValidityDays:90,enrollmentValidityDays:30,registrationNormalization:null,isActive:true,
        }));
        const processing = await inTransaction(client,()=>grantVerificationProcessing(client,student,university,
            {accepted:true,noticeVersion:VERIFICATION_NOTICE_VERSION}));
        await inTransaction(client,async()=>{
            const context = await lockStudentContext(client,student);
            const issued = await requestChallenge(client,{purpose:'student_email',subjectKey:student,
                bindings:{...context,processingGrantId:processing,noticeVersion:VERIFICATION_NOTICE_VERSION}});
            assert.equal(issued.status,'issued'); if(issued.status!=='issued') throw new Error('Challenge fixture failed');
            await consumeChallenge(client,{purpose:'student_email',subjectKey:student,challengeId:issued.challengeId,code:issued.code});
            await recordEmailAssurance(client,student,{challengeId:issued.challengeId,processingGrantId:processing});
        });
        const vendor = (await client.query("INSERT INTO vendors (user_id,name,status) VALUES ($1,$2,'active') RETURNING id",[owner,label])).rows[0].id;
        const origin = 'https://email-only.example';
        await client.query("INSERT INTO widget_configs (vendor_id,allowed_domains,allowed_origins,api_key,status) VALUES ($1,ARRAY['email-only.example'],ARRAY[$2],$3,'active')",[vendor,origin,label]);
        const disclosure = await inTransaction(client,()=>grantMerchantDisclosure(client,student,{
            vendorId:vendor,origin,purpose:'student-discount',accepted:true,noticeVersion:MERCHANT_DISCLOSURE_NOTICE_VERSION,
        }));
        await assert.rejects(issueMerchantAssertion(pool,student,{vendorId:vendor,origin,purpose:'student-discount',campaignId:'email-only',disclosureGrantId:disclosure}),
            /Current student eligibility/);
    } finally {client.release();await pool.end();}
});

test('merchant assertion authority: exact bindings, single use, immutable retry and withdrawal', async () => {
    const pool = createTestPool();
    const client = await pool.connect();
    try {
        const label = randomUUID();
        const insertUser = async (role: string) => (await client.query(
            'INSERT INTO users (email,role) VALUES ($1,$2) RETURNING id', [`${role}-${label}@students.example`,role],
        )).rows[0].id as string;
        const admin = await insertUser('admin'); const student = await insertUser('student'); const owner = await insertUser('vendor');
        const university = (await client.query('INSERT INTO universities (name,is_active) VALUES ($1,true) RETURNING id',[label])).rows[0].id;
        await client.query('INSERT INTO students (user_id,name,university_id) VALUES ($1,$2,$3)',[student,label,university]);
        await inTransaction(client,()=>updateInstitutionPolicy(client,admin,university,{
            domains:['students.example'], emailEvidenceValidityDays:90,enrollmentValidityDays:30,registrationNormalization:null,isActive:true,
        }));
        const processing = await inTransaction(client,()=>grantVerificationProcessing(client,student,university,
            {accepted:true,noticeVersion:VERIFICATION_NOTICE_VERSION}));
        await inTransaction(client,async()=>{
            const context = await lockStudentContext(client,student);
            const issued = await requestChallenge(client,{purpose:'student_email',subjectKey:student,
                bindings:{...context,processingGrantId:processing,noticeVersion:VERIFICATION_NOTICE_VERSION}});
            assert.equal(issued.status,'issued'); if(issued.status!=='issued') throw new Error('Challenge fixture failed');
            await consumeChallenge(client,{purpose:'student_email',subjectKey:student,challengeId:issued.challengeId,code:issued.code});
            await recordEmailAssurance(client,student,{challengeId:issued.challengeId,processingGrantId:processing});
        });
        await client.query(`INSERT INTO university_verification_methods (university_id,method_type,api_endpoint,is_active)
            VALUES ($1,'registration','https://institution.example/verify',true)`,[university]);
        await client.query(`UPDATE universities SET registration_normalization='trim_upper' WHERE id=$1`,[university]);
        const snapshot = await inTransaction(client,()=>beginEnrollmentCheck(client,student,processing));
        const studentEmail = (await client.query(`SELECT lower(btrim(email)) AS email FROM users WHERE id=$1`,[student])).rows[0].email as string;
        assert.equal((await inTransaction(client,()=>applyEnrollmentDecision(client,snapshot,{outcome:'verified',email:studentEmail,
            registrationNumber:'MERCHANT-1',validUntil:new Date(Date.now()+30*86_400_000),source:ENROLLMENT_SOURCE}))).eligible,true);
        const vendor = (await client.query("INSERT INTO vendors (user_id,name,status) VALUES ($1,$2,'active') RETURNING id",[owner,label])).rows[0].id;
        const origin = 'https://ogabassey.example';
        await client.query("INSERT INTO widget_configs (vendor_id,allowed_domains,allowed_origins,api_key,status) VALUES ($1,ARRAY['ogabassey.example'],ARRAY[$2],$3,'active')",[vendor,origin,label]);
        const disclosure = await inTransaction(client,()=>grantMerchantDisclosure(client,student,{
            vendorId:vendor,origin,purpose:'student-discount',accepted:true,noticeVersion:MERCHANT_DISCLOSURE_NOTICE_VERSION,
        }));
        const key = await rotateReportingKey(pool,owner);
        const input = {vendorId:vendor,origin,purpose:'student-discount',campaignId:'demo',disclosureGrantId:disclosure};
        await assert.rejects(issueMerchantAssertion(pool,student,{...input,origin:'https://ogabassey.example:444'}));
        const issued = await issueMerchantAssertion(pool,student,input);
        const stored = (await client.query('SELECT code_hash FROM merchant_assertions WHERE vendor_id=$1',[vendor])).rows[0];
        assert.notEqual(stored.code_hash,issued.code);
        await assert.rejects(exchangeMerchantAssertion(pool,key,{code:issued.code,campaignId:'wrong',idempotencyKey:'first'}),/Campaign/);
        await client.query('BEGIN');
        await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[student]);
        const concurrent = Promise.allSettled(['first','second'].map(idempotencyKey=>exchangeMerchantAssertion(pool,key,{
            code:issued.code,campaignId:'demo',idempotencyKey,
        })));
        try {
            const deadline = Date.now()+5000;
            let blocked = 0;
            do {
                const waiting = await pool.query(`SELECT count(*)::int AS count FROM pg_stat_activity
                    WHERE datname=current_database() AND wait_event_type='Lock'
                    AND query LIKE '%SELECT id, role, deleted_at%'`);
                blocked = waiting.rows[0].count;
                if(blocked>=2) break;
                await new Promise(resolve=>setTimeout(resolve,10));
            } while(Date.now()<deadline);
            assert.equal(blocked,2,'Both exchange operations must be observed waiting on authority locks');
        } finally { await client.query('COMMIT'); }
        const attempts = await concurrent;
        assert.equal(attempts.filter(result=>result.status==='fulfilled').length,1);
        const winner = attempts.findIndex(result=>result.status==='fulfilled');
        const result = attempts[winner]!;
        assert.equal(result.status,'fulfilled'); if(result.status!=='fulfilled') throw new Error('No winner');
        assert.equal(result.value.eligible,true);
        assert.notEqual(result.value.merchantSubject,student);
        assert.equal(JSON.stringify(result.value).includes('@'),false);
        const retryKey = ['first','second'][winner]!;
        const fresh = await issueMerchantAssertion(pool,student,input);
        await assert.rejects(exchangeMerchantAssertion(pool,key,{code:fresh.code,campaignId:'demo',idempotencyKey:retryKey}),/Idempotency/);
        const freshReceipt = await exchangeMerchantAssertion(pool,key,{code:fresh.code,campaignId:'demo',idempotencyKey:'fresh'});
        assert.equal(freshReceipt.merchantSubject,result.value.merchantSubject);
        const expired = await issueMerchantAssertion(pool,student,input);
        await client.query("UPDATE merchant_assertions SET expires_at=clock_timestamp()-interval '1 second' WHERE code_hash=encode(sha256($1::bytea),'hex')",[Buffer.from(expired.code)]);
        await assert.rejects(exchangeMerchantAssertion(pool,key,{code:expired.code,campaignId:'demo',idempotencyKey:'expired'}),/expired/);
        const pending = await issueMerchantAssertion(pool,student,input);
        await inTransaction(client,()=>withdrawConsent(client,student,disclosure));
        assert.deepEqual(await exchangeMerchantAssertion(pool,key,{code:issued.code,campaignId:'demo',idempotencyKey:retryKey}),result.value);
        await assert.rejects(exchangeMerchantAssertion(pool,key,{code:pending.code,campaignId:'demo',idempotencyKey:'withdrawn'}),/eligible/);
        assert.equal((await client.query('SELECT consumed_at FROM merchant_assertions WHERE code_hash=encode(sha256($1::bytea),\'hex\')',[Buffer.from(pending.code)])).rows[0].consumed_at,null);
        await rotateReportingKey(pool,owner);
        await assert.rejects(exchangeMerchantAssertion(pool,key,{code:issued.code,campaignId:'demo',idempotencyKey:retryKey}));
    } finally {client.release();await pool.end();}
});
