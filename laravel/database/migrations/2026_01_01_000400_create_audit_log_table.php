<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Who changed what, when, and what it was before.
 *
 * Required by the spec on estimates, change orders and any edit to a submitted
 * time entry. Built generic (morph target + old/new JSON) so one table covers
 * all three rather than three near-identical ones.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('audit_log', function (Blueprint $table) {
            $table->id();
            $table->morphs('auditable');
            $table->foreignId('employee_id')->nullable()
                ->constrained()->nullOnDelete();
            $table->string('action', 32);           // created / updated / deleted
            $table->string('field', 64)->nullable(); // null = whole-record event
            $table->json('old_value')->nullable();
            $table->json('new_value')->nullable();
            $table->string('ip_address', 45)->nullable();
            $table->timestamp('created_at')->useCurrent();

            $table->index(['auditable_type', 'auditable_id', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('audit_log');
    }
};
