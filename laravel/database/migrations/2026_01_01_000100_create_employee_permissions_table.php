<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * What each employee is allowed to reach. One row per granted permission.
 *
 * Three roles decide what a *response* may contain, and they are deliberately
 * coarse because the spec's rule is absolute: cost and margin must never be
 * rendered in a crew-role response, not even hidden in the DOM.
 *
 *   owner      sees cost and margin
 *   crew_lead  sees scope, materials and hours — no cost
 *   crew       sees their own punches only
 *
 * Finer permissions (quotes, pricing, tasks, …) are additive on top and cannot
 * widen the money rule.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('employees', function (Blueprint $table) {
            $table->enum('role', ['owner', 'crew_lead', 'crew'])
                ->default('crew')->after('active')->index();
        });

        Schema::create('employee_permissions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('employee_id')->constrained()->cascadeOnDelete();
            $table->string('permission', 64);
            $table->timestamps();

            $table->unique(['employee_id', 'permission']);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('employee_permissions');
        Schema::table('employees', fn (Blueprint $t) => $t->dropColumn('role'));
    }
};
